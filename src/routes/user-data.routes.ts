// HTTP surface for user-data export and import.
//
// - GET  /api/v1/user-data/export    → streams a .lvbak archive
// - POST /api/v1/user-data/import    → uploads an archive, returns a jobId
// - GET  /api/v1/user-data/import/:jobId/status → poll job status
// - POST /api/v1/user-data/import/:jobId/cancel → request cancellation

import { Hono } from "hono";
import { buildExportStream } from "../services/user-data/export.service";
import {
  createTicket,
  consumePrepareEntry,
  stashPrepareEntry,
} from "../services/user-data/secret-ticket.service";
import { listSecretKeys, getSecret as readSecret } from "../services/secrets.service";
import {
  persistUploadedArchive,
  startImport,
  getJob,
  reserveImportUpload,
  releaseImportUpload,
  cancelJob,
  verifyArchiveFast,
  submitTicket,
  skipTicket,
  ArchiveValidationError,
  MAX_COMPRESSED_BYTES,
} from "../services/user-data/import.service";
import { TicketError } from "../services/user-data/secret-ticket.service";
import { unlinkSync } from "fs";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getDb } from "../db/connection";

const app = new Hono();

/**
 * UTC timestamp in `YYYY-MM-DD-HHMMSS` form. Used in export filenames so a
 * directory of backups sorts chronologically and a same-day re-export
 * doesn't collide with its predecessor.
 */
function exportTimestamp(d: Date = new Date()): string {
  const iso = d.toISOString();           // "2026-05-21T14:30:52.123Z"
  const datePart = iso.slice(0, 10);     // "2026-05-21"
  const timePart = iso.slice(11, 19).replace(/:/g, ""); // "143052"
  return `${datePart}-${timePart}`;
}

function lookupUserSlug(userId: string): string {
  try {
    const row = getDb()
      .query('SELECT username, displayUsername, name FROM "user" WHERE id = ?')
      .get(userId) as { username?: string; displayUsername?: string; name?: string } | null;
    const candidate = row?.username || row?.displayUsername || row?.name || "user";
    return candidate.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "user";
  } catch {
    return "user";
  }
}

// ─── Export ──────────────────────────────────────────────────────────────

function streamingResponse(stream: ReadableStream<Uint8Array>, filename: string): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Transfer-Encoding": "chunked",
      // Tell nginx-family proxies (including NPMPlus) to stream this response
      // directly to the client instead of buffering the whole archive into
      // memory / disk first. Without this, archives over the proxy_buffers
      // budget spill to a temp file, which caps throughput at disk speed.
      "X-Accel-Buffering": "no",
    },
  });
}

// Original streaming export — unchanged for archives that don't carry secrets.
// Used directly when the UI ticks "no API keys" so the existing single-click
// download UX keeps working without a prepare round-trip.
app.get("/export", (c) => {
  const userId = c.get("userId");
  const includeVectors = c.req.query("includeVectors") !== "0";
  const slug = lookupUserSlug(userId);
  const filename = `lumiverse-${slug}-${exportTimestamp()}.lvbak`;
  const stream = buildExportStream({
    userId,
    includeVectors,
    signal: c.req.raw.signal,
    producerVersion: null,
  });
  return streamingResponse(stream, filename);
});

// Two-step export used by the "Include API keys" path. The prepare step
// generates an archiveId + (when secrets are included) an AES key, returns
// the ticket payload as JSON for the UI to save out-of-band, and stashes the
// key in memory keyed by archiveId. The matching GET below consumes the
// staged entry, streams the archive, and discards the key immediately.
//
// We use two endpoints because a streamed download must be triggered via
// `<a href>` for the browser to surface a save dialog without buffering the
// archive into JS memory — and `<a href>` can only fire a GET. The ticket
// JSON is small enough that the UI receives it through the prepare POST and
// blobs it into a download alongside the archive.
app.post("/export/prepare", async (c) => {
  const userId = c.get("userId");
  let body: { includeVectors?: boolean; includeSecrets?: boolean } = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    // empty body is fine — both flags default to false.
  }
  const includeVectors = !!body.includeVectors;
  const includeSecrets = !!body.includeSecrets;
  const archiveId = crypto.randomUUID();

  let ticket: ReturnType<typeof createTicket> extends Promise<infer R>
    ? R extends { ticket: infer T }
      ? T
      : never
    : never;
  let smk: Uint8Array | null = null;
  let secretKeys: string[] = [];
  let unreachableSecrets: string[] = [];

  if (includeSecrets) {
    // Pre-flight pass: enumerate every secret and try to decrypt it with the
    // source instance's identity key. Anything that fails (legacy/orphaned
    // row, identity-key drift, corruption) is dropped from the binding so
    // the ticket's secretsHash matches exactly what the archive will carry,
    // and so the import doesn't see phantom entries in secrets/index.json.
    let candidates: string[] = [];
    try {
      candidates = listSecretKeys(userId);
    } catch {
      candidates = [];
    }
    for (const key of candidates) {
      try {
        const value = await readSecret(userId, key);
        if (value !== null) {
          secretKeys.push(key);
        } else {
          unreachableSecrets.push(key);
        }
      } catch (err) {
        const e = err as { name?: string; message?: string };
        console.warn(
          `[user-data export] preflight skip ${key}: ${e?.name || "Error"}: ${
            e?.message || String(err)
          }`,
        );
        unreachableSecrets.push(key);
      }
    }
    const created = await createTicket(archiveId, secretKeys, { issuerInstance: null });
    ticket = created.ticket;
    smk = created.smk;
  } else {
    ticket = null as any;
  }

  const slug = lookupUserSlug(userId);
  const stamp = exportTimestamp();
  const archiveFilename = `lumiverse-${slug}-${stamp}.lvbak`;
  const ticketFilename = `lumiverse-${slug}-${stamp}.ticket.json`;

  stashPrepareEntry(archiveId, {
    userId,
    includeVectors,
    includeSecrets,
    smk,
    secretKeys,
    archiveFilename,
    createdAt: Math.floor(Date.now() / 1000),
  });

  return c.json({
    archiveId,
    archiveUrl: `/api/v1/user-data/export/archive/${archiveId}`,
    archiveFilename,
    ticketFilename: includeSecrets ? ticketFilename : null,
    ticket: includeSecrets ? ticket : null,
    secretsCount: secretKeys.length,
    /**
     * Secret keys that couldn't be decrypted at prepare time and were
     * therefore excluded from the ticket binding and the encrypted blob.
     * The UI surfaces these so the user knows what won't round-trip.
     */
    unreachableSecrets,
  });
});

app.get("/export/archive/:archiveId", (c) => {
  const userId = c.get("userId");
  const archiveId = c.req.param("archiveId");
  const entry = consumePrepareEntry(archiveId);
  if (!entry || entry.userId !== userId) {
    return c.json(
      { error: "Export session not found. Call /export/prepare first." },
      404,
    );
  }
  // Reuse the filename pinned at prepare time so the archive and its paired
  // ticket share the exact same HHMMSS suffix on disk.
  const filename =
    entry.archiveFilename || `lumiverse-${lookupUserSlug(userId)}-${exportTimestamp()}.lvbak`;
  const stream = buildExportStream({
    userId: entry.userId,
    includeVectors: entry.includeVectors,
    signal: c.req.raw.signal,
    producerVersion: null,
    archiveId,
    secrets:
      entry.includeSecrets && entry.smk
        ? { smk: entry.smk, secretKeys: entry.secretKeys }
        : undefined,
  });
  return streamingResponse(stream, filename);
});

// ─── Import ──────────────────────────────────────────────────────────────

app.post("/import", async (c) => {
  const userId = c.get("userId");
  // Reserve before awaiting the body stream. A plain status check here is
  // racy: two concurrent handlers can both pass it, then stage two huge
  // archives before either one creates its background job.
  const jobId = reserveImportUpload(userId);
  if (!jobId) {
    return c.json({ error: "an import is already in progress" }, 409);
  }
  let jobStarted = false;
  let archivePath: string | null = null;

  try {
    const declared = Number(c.req.header("content-length") || "0");
    if (declared > MAX_COMPRESSED_BYTES) {
      return c.json(
        { error: "archive exceeds compressed size cap", maxBytes: MAX_COMPRESSED_BYTES },
        413,
      );
    }

    try {
      const ct = c.req.header("content-type") || "";
      if (ct.startsWith("multipart/form-data")) {
        // Bun's formData() parser materializes the complete multipart body in
        // memory. That is unsafe for account archives on low-memory hosts.
        return c.json(
          {
            error:
              "multipart archive uploads are not supported; send the archive as the raw request body",
            code: "multipart_not_supported",
          },
          415,
        );
      }

      const body = c.req.raw.body;
      const size = declared > 0 ? declared : null;
      if (!body) return c.json({ error: "request body is empty" }, 400);

      const persisted = await persistUploadedArchive(userId, body, size, jobId);
      archivePath = persisted.path;
    } catch (err: any) {
      if (err instanceof ArchiveValidationError) {
        const status =
          err.code === "size" ? 413 : err.code === "not_zip" ? 415 : 400;
        return c.json({ error: err.message, code: err.code }, status);
      }
      return c.json({ error: err?.message || "upload failed" }, 400);
    }

    eventBus.emit(
      EventType.USER_IMPORT_PROGRESS,
      { jobId, phase: "verifying" },
      userId,
    );
    try {
      await verifyArchiveFast(archivePath);
    } catch (err: any) {
      try {
        unlinkSync(archivePath);
      } catch {
        /* ignore */
      }
      if (err instanceof ArchiveValidationError) {
        const status = err.code === "no_manifest" || err.code === "bad_manifest" ? 422 : 400;
        return c.json({ error: err.message, code: err.code }, status);
      }
      return c.json({ error: err?.message || "archive validation failed" }, 400);
    }

    try {
      const job = startImport({ userId, archivePath, jobId });
      jobStarted = true;
      return c.json({ jobId: job.jobId, status: job.status }, 202);
    } catch (err: any) {
      try {
        unlinkSync(archivePath);
      } catch {
        /* ignore */
      }
      return c.json({ error: err?.message || "failed to start import" }, 500);
    }
  } finally {
    if (!jobStarted) releaseImportUpload(userId, jobId);
  }
});

app.get("/import/:jobId/status", (c) => {
  const userId = c.get("userId");
  const job = getJob(c.req.param("jobId"));
  if (!job || job.userId !== userId) {
    return c.json({ error: "job not found" }, 404);
  }
  return c.json({
    jobId: job.jobId,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    manifest: job.manifest,
    summary: job.summary,
    fileSummary: job.fileSummary,
    error: job.error,
  });
});

app.post("/import/:jobId/cancel", (c) => {
  const userId = c.get("userId");
  const job = getJob(c.req.param("jobId"));
  if (!job || job.userId !== userId) {
    return c.json({ error: "job not found" }, 404);
  }
  const ok = cancelJob(job.jobId);
  return c.json({ cancelled: ok, status: job.status });
});

// Submit a decryption ticket to a job paused in `awaiting_ticket`. Body is
// the ticket JSON (the file the user downloaded alongside the archive).
// Response surfaces an advisory `wasReused` flag — reuse is allowed (backup
// archives are a legitimate use case) but the UI shows a warning so the
// user can confirm they meant to do it.
app.post("/import/:jobId/ticket", async (c) => {
  const userId = c.get("userId");
  const job = getJob(c.req.param("jobId"));
  if (!job || job.userId !== userId) {
    return c.json({ error: "job not found" }, 404);
  }
  if (job.status !== "awaiting_ticket") {
    return c.json(
      { error: "Job is not awaiting a ticket", status: job.status },
      409,
    );
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Ticket body must be valid JSON" }, 400);
  }
  try {
    const result = await submitTicket(job.jobId, raw);
    return c.json({
      accepted: true,
      wasReused: result.wasReused,
      previouslyConsumedAt: result.previouslyConsumedAt,
      uses: result.uses,
    });
  } catch (err: any) {
    if (err instanceof TicketError) {
      const status =
        err.code === "archive_mismatch" || err.code === "binding_mismatch"
          ? 409
          : err.code === "unsupported_version"
            ? 422
            : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    return c.json({ error: err?.message || "ticket submission failed" }, 400);
  }
});

// Resume an `awaiting_ticket` job WITHOUT restoring secrets. The rest of
// the archive (presets, chats, characters, etc.) is imported as usual.
app.post("/import/:jobId/skip-ticket", (c) => {
  const userId = c.get("userId");
  const job = getJob(c.req.param("jobId"));
  if (!job || job.userId !== userId) {
    return c.json({ error: "job not found" }, 404);
  }
  const ok = skipTicket(job.jobId);
  if (!ok) {
    return c.json(
      { error: "Job is not awaiting a ticket", status: job.status },
      409,
    );
  }
  return c.json({ skipped: true });
});

export { app as userDataRoutes };
