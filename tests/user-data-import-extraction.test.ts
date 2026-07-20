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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Patch only the central-directory metadata, as the old async writer did. */
function patchCentralDirectoryEntry(
  archive: Uint8Array,
  name: string,
  expectedBytes: Uint8Array,
): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 46 <= archive.byteLength; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > archive.byteLength) continue;
    const entryName = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    if (entryName !== name) continue;
    view.setUint32(offset + 16, crc32(expectedBytes), true);
    view.setUint32(offset + 24, expectedBytes.byteLength, true);
    return;
  }
  throw new Error(`central-directory entry not found: ${name}`);
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

  test("recovers a duplicated legacy NDJSON entry when its original ZIP metadata matches", async () => {
    const archivePath = join(workDir, "legacy-duplicated-ndjson.lvbak");
    const worldBookId = "11111111-1111-1111-1111-111111111111";
    const entryDefaults = {
      world_book_id: worldBookId,
      key: "[]",
      keysecondary: "[]",
      comment: "",
      position: 0,
      depth: 4,
      order_value: 100,
      selective: 0,
      constant: 0,
      disabled: 0,
      group_name: "",
      group_override: 0,
      group_weight: 100,
      probability: 100,
      case_sensitive: 0,
      match_whole_words: 0,
      extensions: "{}",
      created_at: 0,
      updated_at: 0,
      use_regex: 0,
      prevent_recursion: 0,
      exclude_recursion: 0,
      delay_until_recursion: 0,
      priority: 10,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      selective_logic: 0,
      use_probability: 1,
      vectorized: 0,
      vector_index_status: "not_enabled",
    };
    const rows = [
      {
        ...entryDefaults,
        id: "22222222-2222-2222-2222-222222222222",
        uid: "one",
        content: "first",
      },
      {
        ...entryDefaults,
        id: "33333333-3333-3333-3333-333333333333",
        uid: "two",
        content: "second",
      },
    ];
    const intended = strToU8(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    const archive = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest({ modern: false }))),
      "database/world_books.ndjson": strToU8(
        `${JSON.stringify({
          id: worldBookId,
          name: "Recovered world book",
          description: "",
          metadata: "{}",
          created_at: 0,
          updated_at: 0,
          user_id: "source-user",
          folder: "",
        })}\n`,
      ),
      // The compressed stream contains the old exporter bug: both rows are
      // present twice. Its central directory, however, still describes the
      // intended unique stream below.
      "database/world_book_entries.ndjson": strToU8(
        new TextDecoder().decode(intended) + new TextDecoder().decode(intended),
      ),
    });
    patchCentralDirectoryEntry(archive, "database/world_book_entries.ndjson", intended);
    writeFileSync(archivePath, archive);

    const job = startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb().query("SELECT id, content FROM world_book_entries ORDER BY id").all(),
    ).toEqual([
      { id: "22222222-2222-2222-2222-222222222222", content: "first" },
      { id: "33333333-3333-3333-3333-333333333333", content: "second" },
    ]);
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
