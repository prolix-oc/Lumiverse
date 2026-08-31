// HTTP surface for user-data export and import.
//
// - GET  /api/v1/user-data/export    → streams a .lvbak archive
// - POST /api/v1/user-data/import    → uploads an archive, returns a jobId
// - GET  /api/v1/user-data/import/:jobId/status → poll job status
// - POST /api/v1/user-data/import/:jobId/cancel → request cancellation

import { Hono, type Context } from "hono";
import { buildExportStream } from "../services/user-data/export.service";
import {
  createTicket,
  consumePrepareEntry,
  restorePrepareEntry,
  stashPrepareEntry,
  TicketError,
  type ExportPrepareEntry,
  type NewTicket,
} from "../services/user-data/secret-ticket.service";
import { listSecretKeys, getSecret as readSecret } from "../services/secrets.service";
import { migrateLegacyImageGenerationSecrets } from "../services/image-gen.service";
import { withImageGenConnectionOwnerLock } from "../services/image-gen-connections.service";
import {
  fingerprintPrivateDataAndSecretInventory,
  type PrivateDataSecretInventoryEntry,
} from "../services/user-data/private-data";
import {
  persistUploadedArchive,
  startImport,
  getJob,
  reserveImportUpload,
  releaseImportUpload,
  cancelImportForUser,
  verifyArchiveFast,
  submitTicket,
  skipTicket,
  ArchiveValidationError,
  ArchiveIdempotencyError,
  MAX_COMPRESSED_BYTES,
  MAX_IMPORT_UPLOAD_WALL_MS,
  MAX_IMPORT_UPLOAD_IDLE_MS,
} from "../services/user-data/import.service";
import { unlinkSync } from "fs";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { ArchiveManifest } from "../services/user-data/manifest";
import { getDb } from "../db/connection";

function currentPrivateDataFingerprint(userId: string): string {
  const db = getDb();
  const settingRow = db.query(
    "SELECT value FROM settings WHERE key = 'imageGeneration' AND user_id = ?",
  ).get(userId) as { value?: unknown } | null;
  let imageGenerationSetting: unknown = undefined;
  if (settingRow) {
    if (typeof settingRow.value !== "string") {
      throw new Error("imageGeneration settings value is not JSON text");
    }
    try {
      imageGenerationSetting = JSON.parse(settingRow.value);
    } catch {
      throw new Error("imageGeneration settings value is malformed JSON");
    }
  }
  const inventory = db.query(
    "SELECT key, encrypted_value, iv, tag, updated_at FROM secrets WHERE user_id = ? ORDER BY key",
  ).all(userId) as PrivateDataSecretInventoryEntry[];
  return fingerprintPrivateDataAndSecretInventory(imageGenerationSetting, inventory);
}

function discardPreparedSecretMaterial(entry: ExportPrepareEntry): void {
  try {
    entry.smk?.fill(0);
  } finally {
    entry.smk = null;
  }
}

const ARCHIVE_ERROR_MESSAGES: Record<string, string> = {
  not_zip: "archive is not a ZIP file",
  size: "archive exceeds the compressed size cap",
  no_manifest: "archive manifest is missing",
  bad_manifest: "archive manifest is invalid",
  upload_timeout: "archive upload timed out",
  upload_aborted: "archive upload was cancelled",
  archive_identity_mismatch: "archive identity does not match the existing import",
};

/**
 * nginx's "Client Closed Request" convention. It is the correct wire status
 * for an upload the client abandoned, but it is outside Hono's
 * ContentfulStatusCode union, so it can only be produced by constructing the
 * Response directly.
 */
const CLIENT_CLOSED_REQUEST = 499;

type ArchiveFailureStatus = 400 | 408 | 409 | 413 | 415 | 422 | typeof CLIENT_CLOSED_REQUEST;

interface ArchiveFailure {
  readonly status: ArchiveFailureStatus;
  readonly body: { error: string; code: string };
}

function publicArchiveFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ArchiveFailure {
  if (error instanceof ArchiveIdempotencyError) {
    return { status: 409, body: { error: ARCHIVE_ERROR_MESSAGES.archive_identity_mismatch, code: error.code } };
  }
  if (error instanceof ArchiveValidationError) {
    const status: ArchiveFailureStatus = error.code === "size"
      ? 413
      : error.code === "not_zip"
        ? 415
        : error.code === "upload_timeout"
          ? 408
          : error.code === "upload_aborted"
            ? CLIENT_CLOSED_REQUEST
            : 422;
    return {
      status,
      body: { error: ARCHIVE_ERROR_MESSAGES[error.code] || fallbackMessage, code: error.code },
    };
  }
  return { status: 400, body: { error: fallbackMessage, code: fallbackCode } };
}

/** Render an archive failure, preserving the client-abort status exactly. */
function archiveFailureResponse(c: Context, failure: ArchiveFailure): Response {
  if (failure.status === CLIENT_CLOSED_REQUEST) {
    return new Response(JSON.stringify(failure.body), {
      status: CLIENT_CLOSED_REQUEST,
      headers: { "content-type": "application/json" },
    });
  }
  return c.json(failure.body, failure.status);
}

function publicTicketFailure(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof TicketError) {
    const message =
      error.code === "archive_mismatch"
        ? "ticket does not match this archive"
        : error.code === "binding_mismatch"
          ? "ticket is not valid for this import"
          : error.code === "stale"
            ? "ticket is expired or outside its validity window"
            : error.code === "replayed"
              ? "ticket has already been consumed"
              : error.code === "wrong_issuer"
                ? "ticket issuer is not accepted"
                : error.code === "invalid_issuer_instance"
                  ? "ticket issuer identity is invalid"
                  : error.code === "unsupported_version"
                    ? "ticket version is unsupported"
                    : "ticket is invalid";
    const status =
      error.code === "archive_mismatch"
      || error.code === "binding_mismatch"
      || error.code === "stale"
      || error.code === "replayed"
        ? 409
        : 400;
    return { status, body: { error: message, code: error.code } };
  }
  return { status: 400, body: { error: "ticket submission failed", code: "ticket_submission_failed" } };
}
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
/**
 * Keep the owner-checked prepare entry available when the response is aborted
 * or the archive stream fails. A successful stream is the only path that
 * destroys the in-memory SMK.
 */
function retryableExportStream(
  stream: ReadableStream<Uint8Array>,
  archiveId: string,
  userId: string,
  entry: ExportPrepareEntry,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let settled = false;
  let readerReleased = false;
  const releaseReader = (): void => {
    if (readerReleased) return;
    readerReleased = true;
    try {
      reader.releaseLock();
    } catch {
      // The reader may already have released itself after cancellation.
    }
  };
  const removeAbortListener = (): void => signal.removeEventListener("abort", onAbort);
  const restore = (): void => {
    if (settled) return;
    settled = true;
    restorePrepareEntry(archiveId, userId, entry);
  };
  const complete = (): void => {
    if (settled) return;
    settled = true;
    entry.smk?.fill(0);
    entry.smk = null;
  };
  const onAbort = (): void => {
    restore();
    void reader.cancel(signal.reason)
      .catch(() => undefined)
      .finally(releaseReader);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          removeAbortListener();
          complete();
          releaseReader();
          controller.close();
        } else if (result.value) {
          controller.enqueue(result.value);
        }
      } catch (error) {
        removeAbortListener();
        restore();
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      removeAbortListener();
      restore();
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
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

  let ticket: NewTicket["ticket"] | null = null;
  let smk: Uint8Array | null = null;
  const secretKeys: string[] = [];
  let privateDataFingerprint: string | null = null;

  if (includeSecrets) {
    await withImageGenConnectionOwnerLock(userId, async () => {
      // Migration, profile/default cleanup, secret enumeration and ticket
      // binding are one same-owner critical section. Awaited encryption for a
      // different account is not blocked.
      const migratedSecretKeys = await migrateLegacyImageGenerationSecrets(userId);
      const candidates = listSecretKeys(userId);
      const candidateSet = new Set(candidates);
      for (const key of migratedSecretKeys) {
        if (!candidateSet.has(key)) {
          throw new Error("migrated image credential " + key + " is missing from export enumeration");
        }
      }
      for (const key of candidates) {
        if (c.req.raw.signal.aborted) {
          throw c.req.raw.signal.reason ?? new Error("export cancelled");
        }
        const value = await readSecret(userId, key);
        if (value === null) throw new Error("secret " + key + " could not be read for export");
        secretKeys.push(key);
      }

      const created = await createTicket(archiveId, secretKeys);
      try {
        const recheckedKeys = listSecretKeys(userId);
        if (
          recheckedKeys.length !== secretKeys.length
          || recheckedKeys.some((key, index) => key !== secretKeys[index])
        ) {
          throw new Error("secret set changed during export preparation");
        }
        privateDataFingerprint = currentPrivateDataFingerprint(userId);
        ticket = created.ticket;
        smk = created.smk;
      } catch (error) {
        created.smk.fill(0);
        throw error;
      }
    });
  }

  const slug = lookupUserSlug(userId);
  const stamp = exportTimestamp();
  const archiveFilename = `lumiverse-${slug}-${stamp}.lvbak`;
  const ticketFilename = `lumiverse-${slug}-${stamp}.ticket.json`;

  const retained = stashPrepareEntry(archiveId, {
    userId,
    includeVectors,
    includeSecrets,
    smk,
    secretKeys,
    privateDataFingerprint,
    archiveFilename,
    createdAt: Math.floor(Date.now() / 1000),
  });
  if (!retained) {
    // stashPrepareEntry clears the SMK on a hard per-user/process capacity
    // failure. Never return a ticket whose matching key is no longer retained.
    return c.json(
      { error: "too many pending exports; try again after an existing export completes", code: "export_capacity" },
      503,
    );
  }

  return c.json({
    archiveId,
    archiveUrl: `/api/v1/user-data/export/archive/${archiveId}`,
    archiveFilename,
    ticketFilename: includeSecrets ? ticketFilename : null,
    ticket: includeSecrets ? ticket : null,
    secretsCount: secretKeys.length,
    // Strict exports never omit a source key. Keep the field for clients that
    // understand older prepare responses; a non-empty value is no longer
    // produced because a failure aborts the whole key-bearing export.
    unreachableSecrets: [],
  });
});

app.get("/export/archive/:archiveId", async (c) => {
  const userId = c.get("userId");
  const archiveId = c.req.param("archiveId");
  const entry = consumePrepareEntry(archiveId, userId);
  if (!entry) {
    return c.json(
      { error: "Export session not found. Call /export/prepare first." },
      404,
    );
  }
  if (entry.includeSecrets) {
    let currentFingerprint: string;
    try {
      currentFingerprint = await withImageGenConnectionOwnerLock(
        userId,
        async () => currentPrivateDataFingerprint(userId),
      );
    } catch {
      discardPreparedSecretMaterial(entry);
      return c.json(
        { error: "Export source changed after preparation. Prepare a new export.", code: "export_source_changed" },
        409,
      );
    }
    if (
      !entry.smk
      || !entry.privateDataFingerprint
      || currentFingerprint !== entry.privateDataFingerprint
    ) {
      discardPreparedSecretMaterial(entry);
      return c.json(
        { error: "Export source changed after preparation. Prepare a new export.", code: "export_source_changed" },
        409,
      );
    }
  }
  // Reuse the filename pinned at prepare time so the archive and its paired
  // ticket share the exact same HHMMSS suffix on disk.
  const filename =
    entry.archiveFilename || `lumiverse-${lookupUserSlug(userId)}-${exportTimestamp()}.lvbak`;
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = buildExportStream({
      userId: entry.userId,
      includeVectors: entry.includeVectors,
      signal: c.req.raw.signal,
      producerVersion: null,
      archiveId,
      secrets:
        entry.includeSecrets && entry.smk
          ? {
              smk: entry.smk,
              secretKeys: entry.secretKeys,
              privateDataFingerprint: entry.privateDataFingerprint!,
            }
          : undefined,
    });
  } catch (error) {
    restorePrepareEntry(archiveId, userId, entry);
    throw error;
  }
  return streamingResponse(
    retryableExportStream(stream, archiveId, userId, entry, c.req.raw.signal),
    filename,
  );
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
  let persistedArchive: Awaited<ReturnType<typeof persistUploadedArchive>> | null = null;
  let verifiedManifest: ArchiveManifest | null = null;

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

      persistedArchive = await persistUploadedArchive(userId, body, size, jobId, {
        signal: c.req.raw.signal,
        wallDeadlineAt: Date.now() + MAX_IMPORT_UPLOAD_WALL_MS,
        idleDeadlineMs: MAX_IMPORT_UPLOAD_IDLE_MS,
      });
      archivePath = persistedArchive.path;
    } catch (err: unknown) {
      const failure = publicArchiveFailure(err, "upload_failed", "archive upload failed");
      return archiveFailureResponse(c, failure);
    }
    eventBus.emit(
      EventType.USER_IMPORT_PROGRESS,
      { jobId, phase: "verifying" },
      userId,
    );
    try {
      if (!archivePath) throw new Error("archive upload did not produce a path");
      verifiedManifest = await verifyArchiveFast(archivePath);
    } catch (err: unknown) {
      if (archivePath) {
        try {
          unlinkSync(archivePath);
        } catch {
          /* ignore */
        }
      }
      const failure = publicArchiveFailure(err, "archive_validation_failed", "archive validation failed");
      return archiveFailureResponse(c, failure);
    }

    try {
      if (!archivePath || !persistedArchive || !verifiedManifest) {
        return c.json({ error: "archive validation failed", code: "archive_validation_failed" }, 422);
      }
      const job = await startImport({
        userId,
        archivePath,
        jobId,
        archiveId: verifiedManifest.archiveId,
        archiveDigest: persistedArchive.archiveDigest,
        archiveBytes: persistedArchive.byteCount,
        uploadProof: persistedArchive.proof,
        idempotencyKey: verifiedManifest.archiveId,
        signal: c.req.raw.signal,
        deadlineAt: Date.now() + MAX_IMPORT_UPLOAD_WALL_MS,
      });
      jobStarted = true;
      return c.json({ jobId: job.jobId, status: job.status }, 202);
    } catch (err: unknown) {
      try {
        if (archivePath) unlinkSync(archivePath);
      } catch {
        /* ignore */
      }
      const failure = publicArchiveFailure(err, "import_start_failed", "failed to start import");
      return archiveFailureResponse(c, failure);
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
    error: job.error || job.errorCode
      ? { code: job.errorCode || "import_failed", message: "archive import failed" }
      : null,
  });
});

app.post("/import/:jobId/cancel", async (c) => {
  const status = await cancelImportForUser(c.get("userId"), c.req.param("jobId"));
  if (status === "not_found") return c.json({ status } as const, 404);
  if (status === "too_late") return c.json({ status } as const, 409);
  return c.json({ status } as const, 200);
});

// Submit a decryption ticket to a job paused in `awaiting_ticket`.
// Validation completes before the in-memory gate opens. Secret preparation
// and the one-use tombstone occur later in the same synchronous transaction
// as canonical rows and the final receipt, so pre-commit failure is retryable.
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
    await submitTicket(job.jobId, raw);
    return c.json({ accepted: true } as const);
  } catch (err: unknown) {
    const failure = publicTicketFailure(err);
    return c.json(failure.body, failure.status as 400 | 409);
  }
});

// Resume an `awaiting_ticket` job WITHOUT restoring secrets. The rest of
// the archive (presets, chats, characters, etc.) is imported as usual.
app.post("/import/:jobId/skip-ticket", async (c) => {
  const userId = c.get("userId");
  const job = getJob(c.req.param("jobId"));
  if (!job || job.userId !== userId) {
    return c.json({ error: "job not found" }, 404);
  }
  try {
    const ok = await skipTicket(job.jobId);
    if (!ok) {
      return c.json(
        { error: "Job is not awaiting a ticket", status: job.status },
        409,
      );
    }
    return c.json({ skipped: true });
  } catch (err: unknown) {
    const failure = publicTicketFailure(err);
    return c.json(failure.body, failure.status as 400 | 409);
  }
});

export { app as userDataRoutes };
