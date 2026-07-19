import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { env } from "../src/env";
import { buildExportStream } from "../src/services/user-data/export.service";
import { cancelJob, getJob, startImport } from "../src/services/user-data/import.service";

const USER_ID = "bounded-import-user";

function manifest({ modern = true }: { modern?: boolean } = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    producer: "lumiverse",
    exportedAt: 0,
    archiveId: crypto.randomUUID(),
    producerVersion: "test",
    ...(modern ? { ndjsonFormatVersion: 1 } : {}),
    includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    counts: {},
    missingFiles: [],
  };
}

async function waitForTerminal(jobId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(jobId)!;
    if (["complete", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for import job");
}

async function waitForStatus(jobId: string, status: string) {
  for (let i = 0; i < 200; i++) {
    if (getJob(jobId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${status}`);
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

describe("user-data import bounded extraction", () => {
  let workDir: string;
  let originalDataDir: string;

  beforeEach(async () => {
    closeDatabase();
    workDir = mkdtempSync(join(tmpdir(), "lvbak-extraction-test-"));
    originalDataDir = env.dataDir;
    env.dataDir = workDir;
    initDatabase(":memory:");
    const baseline = await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text();
    getDb().run("PRAGMA foreign_keys = OFF");
    getDb().run(baseline);
    getDb()
      .query(
        "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(USER_ID, "Bounded Import", "bounded@example.com", 0, 0);
  });

  afterEach(() => {
    closeDatabase();
    env.dataDir = originalDataDir;
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  test("extracts a normal compressed archive through the central-directory path", async () => {
    const archivePath = join(workDir, "normal.lvbak");
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest())),
        "database/settings.ndjson": strToU8(
          `${JSON.stringify({ key: "bounded_import", value: "true", user_id: "source", updated_at: 0 })}\n`,
        ),
        "files/images/11111111-1111-1111-1111-111111111111.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }),
    );

    const job = startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb().query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get("bounded_import", USER_ID),
    ).toEqual({ value: "true" });
    expect(existsSync(join(workDir, "images", "11111111-1111-1111-1111-111111111111.png"))).toBe(true);
  });

  test("extracts the ZIP64 archive produced by the exporter", async () => {
    const archivePath = join(workDir, "exported.lvbak");
    writeFileSync(
      archivePath,
      await streamToBytes(
        buildExportStream({ userId: USER_ID, includeVectors: false, producerVersion: "test" }),
      ),
    );

    const job = startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
  });

  test("allows a ticket-waiting import to be cancelled", async () => {
    const archivePath = join(workDir, "awaiting-ticket.lvbak");
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({ ...manifest(), hasEncryptedSecrets: true })),
      }),
    );

    const job = startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    await waitForStatus(job.jobId, "awaiting_ticket");
    expect(cancelJob(job.jobId)).toBe(true);
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("cancelled");
  });

  test("rejects a compressed unterminated NDJSON line without retaining its output", async () => {
    const archivePath = join(workDir, "oversized-line.lvbak");
    const oversized = new Uint8Array(5 * 1024 * 1024);
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest())),
        "database/settings.ndjson": oversized,
      }),
    );

    const job = startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("NDJSON line exceeds");
  });

  test("imports an oversized NDJSON record from a pre-fixed-window archive", async () => {
    const archivePath = join(workDir, "legacy-oversized-line.lvbak");
    const value = "x".repeat(5 * 1024 * 1024);
    const row = JSON.stringify({
      key: "legacy_large_setting",
      value,
      user_id: "source-user",
      updated_at: 0,
    });
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest({ modern: false }))),
        "database/settings.ndjson": strToU8(`${row}\n`),
      }),
    );

    const job = startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb()
        .query("SELECT length(value) AS length FROM settings WHERE key = ? AND user_id = ?")
        .get("legacy_large_setting", USER_ID),
    ).toEqual({ length: value.length });
  });

});
