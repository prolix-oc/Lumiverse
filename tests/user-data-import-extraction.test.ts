import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strToU8, unzipSync, zipSync } from "fflate";
import { Database } from "bun:sqlite";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { initIdentity } from "../src/crypto/init";
import { runMigrations } from "../src/db/migrate";
import { env } from "../src/env";
import { buildExportStream } from "../src/services/user-data/export.service";
import { ArtifactBlobStore, publishArtifactCommit } from "../src/services/agent-artifact-blobs.service";
import { attachWorkspaceArtifactReference, proposeWorkspacePublication } from "../src/services/turn-workspace.service";
import {
  __test__ as importTest,
  cancelImportForUser,
  getJob,
  reconcileUserDataImports,
  sha256File,
  skipTicket,
  startImport,
  submitTicket,
} from "../src/services/user-data/import.service";
import { ARCHIVE_REGISTRY_VERSION } from "../src/services/user-data/table-registry";
import { createTicket, encryptSecret, TICKET_MAX_AGE_SECONDS } from "../src/services/user-data/secret-ticket.service";
import {
  MAX_ARCHIVE_FILE_BYTES,
  NDJSON_MAX_RECORD_BYTES,
  type ArchiveManifest,
} from "../src/services/user-data/manifest";

const USER_ID = "bounded-import-user";

function manifest({
  modern = true,
  maxRecordBytes = NDJSON_MAX_RECORD_BYTES,
}: {
  modern?: boolean;
  maxRecordBytes?: number;
} = {}): ArchiveManifest {
  return {
    schemaVersion: modern ? 2 : 1,
    producer: "lumiverse",
    exportedAt: 0,
    archiveId: crypto.randomUUID(),
    producerVersion: "test",
    ...(modern
      ? { ndjsonFormatVersion: 2, ndjsonMaxRecordBytes: maxRecordBytes }
      : {}),
    includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    counts: {},
    missingFiles: [],
  };
}
async function writeEncryptedTicketArchive(
  archivePath: string,
  created: Awaited<ReturnType<typeof createTicket>>,
  secretKey: string,
  extraEntries: Record<string, Uint8Array> = {},
): Promise<void> {
  const encrypted = await encryptSecret(created.smk, secretKey, "ticket-secret");
  writeFileSync(
    archivePath,
    zipSync({
      "manifest.json": strToU8(JSON.stringify({
        ...manifest(),
        archiveId: created.ticket.archiveId,
        hasEncryptedSecrets: true,
        secretsCount: 1,
      })),
      "secrets/index.json": strToU8(JSON.stringify({ keys: [secretKey] })),
      "secrets/encrypted.ndjson": strToU8(`${JSON.stringify(encrypted)}\n`),
      ...extraEntries,
    }),
  );
  created.smk.fill(0);
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
  let workDir = "";
  let originalDataDir = "";

  beforeEach(async () => {
    // Capture first: bun runs afterEach even when beforeEach throws, so a
    // fallible statement before this line would restore undefined into the
    // shared env object and poison later test files in the same process.
    originalDataDir = env.dataDir;
    closeDatabase();
    workDir = mkdtempSync(join(tmpdir(), "lvbak-extraction-test-"));
    env.dataDir = workDir;
    await initIdentity();
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb()
      .query(
        "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(USER_ID, "Bounded Import", "bounded@example.com", 0, 0);
  });

  afterEach(() => {
    importTest.setTicketZeroizationHook(null);
    importTest.setFilesystemCapacityHook(null);
    importTest.setDirectorySyncHook(null);
    importTest.setStagingFootprintHook(null);
    closeDatabase();
    env.dataDir = originalDataDir;
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
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
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb().query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get("bounded_import", USER_ID),
    ).toEqual({ value: "true" });
    expect(getDb().query("SELECT state FROM user_data_imports WHERE job_id = ?").get(job.jobId)).toEqual({ state: "committed" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM user_data_import_receipts WHERE job_id = ?").get(job.jobId)).toEqual({ count: 1 });
  });
  test("scrubs legacy image-generation API keys before merging imported settings", async () => {
    const archivePath = join(workDir, "legacy-image-secrets.lvbak");
    const imageGeneration = {
      enabled: true,
      unrelated: { apiKey: "retained-import-api-key" },
      nanogpt: {
        apiKey: "imported-nanogpt-secret",
        model: "hidream",
        credentials: { apiKey: "imported-deep-secret", label: "primary" },
        variants: [{ nested: { apiKey: "imported-array-secret", steps: 20 } }],
      },
      novelai: { apiKey: "imported-novelai-secret", sampler: "k_euler" },
      compatibility: [
        { nanogpt: { apiKey: "imported-nested-secret", model: "nested" } },
        { wrapper: { novelai: { apiKey: "imported-nested-secret", steps: 28 } } },
      ],
      encodedCompatibility: JSON.stringify({
        wrapper: {
          nanogpt: {
            credentials: { apiKey: "imported-encoded-secret", label: "encoded" },
            model: "encoded-nano",
          },
        },
      }),
    };
    getDb()
      .prepare("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 0)")
      .run("imageGeneration", JSON.stringify({ enabled: false, promptPresets: [] }), USER_ID);
    writeFileSync(archivePath, zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest())),
      "database/settings.ndjson": strToU8(JSON.stringify({
        key: "imageGeneration",
        value: JSON.stringify(imageGeneration),
        user_id: "source-user",
        updated_at: 0,
      }) + "\n"),
    }));

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    const stored = getDb()
      .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
      .get("imageGeneration", USER_ID) as { value: string };
    expect(JSON.parse(stored.value)).toEqual({
      enabled: false,
      promptPresets: [],
      unrelated: { apiKey: "retained-import-api-key" },
      nanogpt: {
        model: "hidream",
        credentials: { label: "primary" },
        variants: [{ nested: { steps: 20 } }],
      },
      novelai: { sampler: "k_euler" },
      compatibility: [
        { nanogpt: { model: "nested" } },
        { wrapper: { novelai: { steps: 28 } } },
      ],
      encodedCompatibility: JSON.stringify({
        wrapper: {
          nanogpt: {
            credentials: { label: "encoded" },
            model: "encoded-nano",
          },
        },
      }),
    });
  });

  test("merges own prototype keys onto an existing image-generation setting", async () => {
    const archivePath = join(workDir, "prototype-image-setting.lvbak");
    const importedValue =
      ' { "__proto__": { "polluted": "no" }, "constructor": { "kind": "imported" }, "enabled": true, "ordinary": "imported", "restored": "yes" } ';
    getDb()
      .prepare("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 0)")
      .run(
        "imageGeneration",
        JSON.stringify({ enabled: false, ordinary: "existing" }),
        USER_ID,
      );
    writeFileSync(archivePath, zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest())),
      "database/settings.ndjson": strToU8(JSON.stringify({
        key: "imageGeneration",
        value: importedValue,
        user_id: "source-user",
        updated_at: 0,
      }) + "\n"),
    }));

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");

    const stored = getDb()
      .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
      .get("imageGeneration", USER_ID) as { value: string };
    const parsed = JSON.parse(stored.value);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(parsed.__proto__).toEqual({ polluted: "no" });
    expect(Object.prototype.hasOwnProperty.call(parsed, "constructor")).toBe(true);
    expect(parsed.constructor).toEqual({ kind: "imported" });
    expect(parsed.enabled).toBe(false);
    expect(parsed.ordinary).toBe("existing");
    expect(parsed.restored).toBe("yes");
    expect(({} as any).polluted).toBeUndefined();
  });

  test("fails the whole import for Unicode-escaped malformed provider data", async () => {
    const archivePath = join(workDir, "malformed-image-setting.lvbak");
    const escapedPrivateData = String.raw`{"\u006e\u0061\u006e\u006f\u0067\u0070\u0074":{"\u0061\u0070\u0069\u004b\u0065\u0079":"escaped-import-secret"}`;
    const rows = [
      { key: "must_not_commit", value: "true", user_id: "source-user", updated_at: 0 },
      {
        key: "imageGeneration",
        value: JSON.stringify({ wrapper: escapedPrivateData }),
        user_id: "source-user",
        updated_at: 0,
      },
    ];
    writeFileSync(archivePath, zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest())),
      "database/settings.ndjson": strToU8(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    }));

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain(
      "imageGeneration settings contain malformed JSON-encoded provider data",
    );
    expect(getDb().query(
      "SELECT value FROM settings WHERE key = ? AND user_id = ?",
    ).get("must_not_commit", USER_ID)).toBeNull();
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM user_data_import_receipts WHERE job_id = ?",
    ).get(job.jobId)).toEqual({ count: 0 });
  });

  test("keeps malformed ticket submission fail closed and retryable", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "malformed-ticket.lvbak");
    const created = await createTicket("malformed-ticket-archive", ["malformed-ticket-secret"]);
    await writeEncryptedTicketArchive(archivePath, created, "malformed-ticket-secret", {
      "database/settings.ndjson": strToU8(JSON.stringify({
        key: "ticket_gated_setting",
        value: "true",
        user_id: "source-user",
        updated_at: 0,
      }) + "\n"),
    });

    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    await expect(submitTicket(jobId, null)).rejects.toMatchObject({
      name: "TicketError",
      code: "malformed",
    });
    expect(getJob(jobId)?.status).toBe("awaiting_ticket");
    expect(getDb().query(
      "SELECT value FROM settings WHERE key = ? AND user_id = ?",
    ).get("ticket_gated_setting", USER_ID)).toBeNull();
    expect(getDb().query(
      "SELECT 1 FROM import_consumed_tickets WHERE archive_id = ?",
    ).get(created.ticket.archiveId)).toBeNull();

    await expect(submitTicket(jobId, created.ticket)).resolves.toEqual({ accepted: true });
    expect((await waitForTerminal(job.jobId)).status).toBe("complete");
  });
  test("materializes canonical rows asynchronously across validation batches", async () => {
    const rowCount = 300;
    const rows = Array.from({ length: rowCount }, (_, index) => JSON.stringify({
      key: `async_materialized_${index}`,
      value: JSON.stringify({ index }),
      user_id: "foreign-source",
      updated_at: index,
    })).join("\n") + "\n";
    const archivePath = join(workDir, "async-materialization.lvbak");
    writeFileSync(archivePath, zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest())),
      "database/settings.ndjson": strToU8(rows),
    }));
    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM settings WHERE user_id = ? AND key LIKE 'async_materialized_%'",
    ).get(USER_ID)).toEqual({ count: rowCount });
  });
  test("replays a V1 archive by digest when new uploads have no archiveId", async () => {
    const legacyManifest: Record<string, unknown> = { ...manifest({ modern: false }) };
    delete legacyManifest.archiveId;
    const archiveBytes = zipSync({
      "manifest.json": strToU8(JSON.stringify(legacyManifest)),
    });
    const firstJobId = crypto.randomUUID();
    const retryJobId = crypto.randomUUID();
    const firstPath = join(workDir, "imports", USER_ID, firstJobId, "archive.lvbak");
    const retryPath = join(workDir, "imports", USER_ID, retryJobId, "archive.lvbak");
    mkdirSync(join(workDir, "imports", USER_ID, firstJobId), { recursive: true });
    mkdirSync(join(workDir, "imports", USER_ID, retryJobId), { recursive: true });
    writeFileSync(firstPath, archiveBytes);
    writeFileSync(retryPath, archiveBytes);

    const first = await waitForTerminal(
      (await startImport({ userId: USER_ID, archivePath: firstPath, jobId: firstJobId })).jobId,
    );
    expect(first.status).toBe("complete");
    const firstReceipt = getDb().query(
      "SELECT idempotency_key, archive_digest, summary_json FROM user_data_import_receipts WHERE user_id = ?",
    ).get(USER_ID) as { idempotency_key: string; archive_digest: string; summary_json: string };
    expect(firstReceipt.idempotency_key.startsWith("legacy-v1:")).toBe(true);

    const duplicate = await startImport({
      userId: USER_ID,
      archivePath: retryPath,
      jobId: retryJobId,
    });
    expect(duplicate.status).toBe("complete");
    expect(duplicate.summary).toEqual(first.summary);
    expect(duplicate.fileSummary).toEqual(first.fileSummary);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM user_data_import_receipts WHERE user_id = ?",
    ).get(USER_ID)).toEqual({ count: 1 });
  });
  test("rejects a V3 archive whose manifest is not the final central-directory entry", async () => {
    const archivePath = join(workDir, "v3-manifest-not-last.lvbak");
    const v3Manifest = {
      ...manifest(),
      schemaVersion: 3,
      embeddingIdentity: "test-embedding",
      vectorStatus: "rebuild_required",
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: "snapshot-test",
      fileAliases: [],
      byteCounts: {},
      missingOptionalFiles: [],
      entries: [],
    };
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(v3Manifest)),
        "database/settings.ndjson": strToU8(
          `${JSON.stringify({ key: "v3_manifest_order", value: "must-fail", user_id: "source" })}\n`,
        ),
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("final ZIP central-directory entry");
  });
  test("rejects a V2 archive carrying an unauthenticated manifest-stats trailer", async () => {
    const archivePath = join(workDir, "v2-manifest-stats.lvbak");
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest())),
        "manifest-stats.json": strToU8(JSON.stringify({ counts: { settings: 1 } })),
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("unauthenticated manifest-stats.json");
  });
  test("dispatches canonical merge policies without cross-key overwrite", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE merge_fixture (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, value TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO merge_fixture (id, slug, value) VALUES (?, ?, ?)");
    const keys = { primaryKey: ["id"], uniqueKeys: [["id"], ["slug"]] };
    const upsert = { ...keys, mergePolicy: "upsert" };
    expect(importTest.mergeCanonicalImportRow(
      db,
      "merge_fixture",
      upsert,
      { id: "one", slug: "first", value: "new" },
      ["id", "slug", "value"],
      insert,
    )).toBe("imported");
    expect(db.query("SELECT value FROM merge_fixture WHERE id = 'one'").get()).toEqual({ value: "new" });
    expect(() => importTest.mergeCanonicalImportRow(
      db,
      "merge_fixture",
      upsert,
      { id: "two", slug: "first", value: "collision" },
      ["id", "slug", "value"],
      insert,
    )).toThrow(/canonical unique-key conflict/);
    const insertOnly = { ...keys, mergePolicy: "insert_only" };
    expect(importTest.mergeCanonicalImportRow(
      db,
      "merge_fixture",
      insertOnly,
      { id: "one", slug: "first", value: "new" },
      ["id", "slug", "value"],
      insert,
    )).toBe("skipped");
    expect(() => importTest.mergeCanonicalImportRow(
      db,
      "merge_fixture",
      insertOnly,
      { id: "one", slug: "first", value: "changed" },
      ["id", "slug", "value"],
      insert,
    )).toThrow(/insert-only/);
    const discard = { ...keys, mergePolicy: "discard" };
    expect(importTest.mergeCanonicalImportRow(
      db,
      "merge_fixture",
      discard,
      { id: "two", slug: "second", value: "discarded" },
      ["id", "slug", "value"],
      insert,
    )).toBe("skipped");
    expect(db.query("SELECT 1 FROM merge_fixture WHERE id = 'two'").get()).toBeNull();
    db.close();
  });
  test("upserts a canonical row whose triggers inflate the SQLite change count", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE merge_fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("CREATE TABLE merge_fixture_log (id INTEGER PRIMARY KEY AUTOINCREMENT, fixture_id TEXT NOT NULL)");
    db.run(`CREATE TRIGGER merge_fixture_touch AFTER UPDATE ON merge_fixture BEGIN
      INSERT INTO merge_fixture_log(fixture_id) VALUES (new.id);
      INSERT INTO merge_fixture_log(fixture_id) VALUES (new.id);
    END`);
    db.run("INSERT INTO merge_fixture (id, value) VALUES ('one', 'old')");
    const insert = db.prepare("INSERT INTO merge_fixture (id, value) VALUES (?, ?)");
    const upsert = { primaryKey: ["id"], uniqueKeys: [["id"]], mergePolicy: "upsert" };
    const inflated = db.query("UPDATE merge_fixture SET value = ? WHERE id = ?").run("probe", "one");
    expect(inflated.changes).toBeGreaterThan(1);
    db.query("UPDATE merge_fixture SET value = ? WHERE id = ?").run("old", "one");
    expect(importTest.mergeCanonicalImportRow(
      db,
      "merge_fixture",
      upsert,
      { id: "one", value: "new" },
      ["id", "value"],
      insert,
    )).toBe("imported");
    expect(db.query("SELECT value FROM merge_fixture WHERE id = 'one'").get()).toEqual({ value: "new" });
    db.close();
  });

  test("round-trips an audio_files row and blob through export and import", async () => {
    const audioId = "22222222-2222-2222-2222-222222222222";
    const filename = `${audioId}.mp3`;
    const audioPath = join(workDir, "audio", filename);
    const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    mkdirSync(join(workDir, "audio"), { recursive: true });
    writeFileSync(audioPath, audioBytes);
    getDb().query(
      `INSERT INTO audio_files (id, user_id, filename, original_filename, mime_type, size_bytes, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(audioId, USER_ID, filename, "clip.mp3", "audio/mpeg", audioBytes.byteLength, null, 0);

    const archivePath = join(workDir, "audio-round-trip.lvbak");
    const archiveBytes = await streamToBytes(
      buildExportStream({ userId: USER_ID, includeVectors: false, producerVersion: "test" }),
    );
    const archive = unzipSync(archiveBytes);
    const audioEntries = Object.keys(archive).filter((name) => name.startsWith("files/audio/"));
    expect(audioEntries).toEqual([`files/audio/${filename}`]);
    expect(new Set(Object.keys(archive)).size).toBe(Object.keys(archive).length);
    writeFileSync(archivePath, archiveBytes);
    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);

    expect(finished.status).toBe("complete");
    expect(existsSync(audioPath)).toBe(true);
    expect(getDb().query("SELECT filename FROM audio_files WHERE id = ? AND user_id = ?").get(audioId, USER_ID))
      .toEqual({ filename });
  });

  test("round-trips a descriptor-only notification sound through export and import", async () => {
    const soundDir = join(workDir, "notification-sounds", USER_ID);
    const soundPath = join(soundDir, "completion.mp3");
    const soundBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    mkdirSync(soundDir, { recursive: true });
    writeFileSync(soundPath, soundBytes);

    const archivePath = join(workDir, "notification-sound-round-trip.lvbak");
    const archiveBytes = await streamToBytes(
      buildExportStream({ userId: USER_ID, includeVectors: false, producerVersion: "test" }),
    );
    const archive = unzipSync(archiveBytes);
    const soundEntries = Object.keys(archive).filter((name) => name.startsWith("files/notification-sounds/"));
    expect(soundEntries).toEqual(["files/notification-sounds/completion.mp3"]);
    expect(new Set(Object.keys(archive)).size).toBe(Object.keys(archive).length);
    writeFileSync(archivePath, archiveBytes);
    rmSync(soundPath);

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(existsSync(soundPath)).toBe(true);
    expect(new Uint8Array(readFileSync(soundPath))).toEqual(soundBytes);
    expect(
      getDb().query(
        "SELECT install_state FROM user_data_import_files WHERE job_id = ? AND archive_path = ?",
      ).get(job.jobId, "files/notification-sounds/completion.mp3"),
    ).toEqual({ install_state: "installed" });
  });
  test("journals fallback creator before bytes, closes before cleanup, and retries after short writes", async () => {
    const sourcePath = join(workDir, "fallback-source.bin");
    const targetDir = join(workDir, "fallback-target", ".lv-import");
    mkdirSync(targetDir, { recursive: true });
    const sourceBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    writeFileSync(sourcePath, sourceBytes);

    const crashPath = join(targetDir, "crash.bin");
    let sawCreatedEmptyFile = false;
    await expect(importTest.copyNoReplace(
      sourcePath,
      crashPath,
      (identity) => {
        sawCreatedEmptyFile = existsSync(crashPath) && identity.size === 0;
        throw new Error("injected crash after wx");
      },
    )).rejects.toThrow("injected crash after wx");
    expect(sawCreatedEmptyFile).toBe(true);
    // This models the Windows-shaped cleanup failure window: the destination
    // must be closed before unlink, and a failed copy must not block retry.
    expect(existsSync(crashPath)).toBe(false);

    const shortWritePath = join(targetDir, "short-write.bin");
    let writeCalls = 0;
    await expect(importTest.copyNoReplace(
      sourcePath,
      shortWritePath,
      undefined,
      (fd, chunk) => {
        writeCalls++;
        writeSync(fd, chunk, 0, Math.max(1, Math.floor(chunk.byteLength / 2)));
        throw new Error("injected short write");
      },
    )).rejects.toThrow("injected short write");
    expect(writeCalls).toBe(1);
    expect(existsSync(shortWritePath)).toBe(false);

    expect(await importTest.copyNoReplace(sourcePath, shortWritePath)).toBe(true);
    expect(new Uint8Array(readFileSync(shortWritePath))).toEqual(sourceBytes);

    const preexistingPath = join(targetDir, "preexisting.bin");
    const preexistingBytes = new Uint8Array([9, 8, 7]);
    writeFileSync(preexistingPath, preexistingBytes);
    expect(await importTest.copyNoReplace(sourcePath, preexistingPath)).toBe(false);
    expect(new Uint8Array(readFileSync(preexistingPath))).toEqual(preexistingBytes);
  });

  test("yields and honors cancellation while hashing and copying large files", async () => {
    const sourcePath = join(workDir, "yield-source.bin");
    const sourceBytes = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < sourceBytes.length; index++) sourceBytes[index] = index % 251;
    writeFileSync(sourcePath, sourceBytes);
    let hashHeartbeats = 0;
    const digest = await sha256File(sourcePath, undefined, undefined, () => { hashHeartbeats++; });
    expect(digest).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
    // The helper performs an initial fence check, yields after each bounded
    // megabyte, and checks again before returning.
    expect(hashHeartbeats).toBeGreaterThanOrEqual(2);

    const hashController = new AbortController();
    let hashAbortHeartbeats = 0;
    await expect(sha256File(
      sourcePath,
      hashController.signal,
      undefined,
      () => {
        hashAbortHeartbeats++;
        if (hashAbortHeartbeats >= 2) hashController.abort(new Error("hash cancelled"));
      },
    )).rejects.toThrow("hash cancelled");

    const targetPath = join(workDir, "yield-target.bin");
    const controller = new AbortController();
    let copyHeartbeats = 0;
    await expect(importTest.copyNoReplace(
      sourcePath,
      targetPath,
      undefined,
      undefined,
      {
        signal: controller.signal,
        heartbeat: () => {
          copyHeartbeats++;
          if (copyHeartbeats >= 2) controller.abort(new Error("copy cancelled"));
        },
      },
    )).rejects.toThrow("copy cancelled");
    expect(copyHeartbeats).toBeGreaterThanOrEqual(2);
    expect(existsSync(targetPath)).toBe(false);

    const leaseLossPath = join(workDir, "lease-loss-target.bin");
    await expect(importTest.copyNoReplace(
      sourcePath,
      leaseLossPath,
      undefined,
      undefined,
      { heartbeat: () => { throw new Error("import lease fence lost"); } },
    )).rejects.toThrow("import lease fence lost");
    expect(existsSync(leaseLossPath)).toBe(false);
  });

  test("removes a creator-proven partial fallback after restart but preserves preexisting content", async () => {
    const sourcePath = join(workDir, "journal-source.bin");
    const sourceBytes = new Uint8Array([10, 20, 30, 40]);
    writeFileSync(sourcePath, sourceBytes);
    const digest = createHash("sha256").update(sourceBytes).digest("hex");
    const now = Math.floor(Date.now() / 1000);

    const insertImport = (jobId: string, owner: string) => {
      getDb().query(
        `INSERT INTO user_data_imports
         (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
          staging_path,staging_db_path,state,lease_owner,lease_expires_at,lease_generation,created_at,updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 'failed', ?, ?, 1, ?, ?)`,
      ).run(
        jobId,
        USER_ID,
        jobId,
        `idempotency-${jobId}`,
        digest,
        workDir,
        workDir,
        owner,
        now + 3_600,
        now,
        now,
      );
    };
    const insertFile = ({
      jobId,
      token,
      finalPath,
      observedFinalIdentity,
    }: {
      jobId: string;
      token: string;
      finalPath: string;
      observedFinalIdentity: string | null;
    }) => {
      const sourceIdentity = statSync(sourcePath);
      getDb().query(
        `INSERT INTO user_data_import_files
         (job_id,archive_path,kind,staged_path,final_path,sha256,byte_count,required,
          install_token,staged_identity,observed_final_identity,install_state,created_at,updated_at)
         VALUES (?, 'files/notification-sounds/completion.mp3', 'file', ?, ?, ?, ?, 0, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        jobId,
        sourcePath,
        finalPath,
        digest,
        sourceBytes.byteLength,
        token,
        JSON.stringify({ dev: Number(sourceIdentity.dev), ino: Number(sourceIdentity.ino), size: sourceIdentity.size, mtimeMs: sourceIdentity.mtimeMs, creatorToken: token }),
        observedFinalIdentity,
        now,
        now,
      );
    };

    const partialJobId = crypto.randomUUID();
    const partialOwner = crypto.randomUUID();
    const partialToken = crypto.randomUUID();
    const partialPath = join(
      workDir,
      "notification-sounds",
      USER_ID,
      ".lv-import",
      `${partialJobId}-${partialToken}-${digest}-completion.mp3`,
    );
    mkdirSync(join(workDir, "notification-sounds", USER_ID, ".lv-import"), { recursive: true });
    const partialFd = openSync(partialPath, "w");
    const creatorIdentity = statSync(partialPath);
    writeSync(partialFd, new Uint8Array([10, 20]));
    closeSync(partialFd);
    insertImport(partialJobId, partialOwner);
    insertFile({
      jobId: partialJobId,
      token: partialToken,
      finalPath: partialPath,
      observedFinalIdentity: JSON.stringify({
        dev: Number(creatorIdentity.dev),
        ino: Number(creatorIdentity.ino),
        size: creatorIdentity.size,
        mtimeMs: creatorIdentity.mtimeMs,
      }),
    });
    getDb().query("UPDATE user_data_import_files SET install_state = 'created' WHERE job_id = ?").run(partialJobId);

    const hardlinkJobId = crypto.randomUUID();
    const hardlinkOwner = crypto.randomUUID();
    const hardlinkToken = crypto.randomUUID();
    const hardlinkPath = join(
      workDir,
      "notification-sounds",
      USER_ID,
      ".lv-import",
      `${hardlinkJobId}-${hardlinkToken}-${digest}-completion.mp3`,
    );
    linkSync(sourcePath, hardlinkPath);
    insertImport(hardlinkJobId, hardlinkOwner);
    insertFile({
      jobId: hardlinkJobId,
      token: hardlinkToken,
      finalPath: hardlinkPath,
      observedFinalIdentity: null,
    });

    const preexistingJobId = crypto.randomUUID();
    const preexistingOwner = crypto.randomUUID();
    const preexistingToken = crypto.randomUUID();
    const preexistingPath = join(
      workDir,
      "notification-sounds",
      USER_ID,
      ".lv-import",
      `${preexistingJobId}-${preexistingToken}-${digest}-completion.mp3`,
    );
    writeFileSync(preexistingPath, sourceBytes);
    insertImport(preexistingJobId, preexistingOwner);
    insertFile({
      jobId: preexistingJobId,
      token: preexistingToken,
      finalPath: preexistingPath,
      observedFinalIdentity: null,
    });

    await importTest.rollbackCreatedFiles(partialJobId, {
      leaseOwner: partialOwner,
      leaseGeneration: 1,
    });
    await importTest.rollbackCreatedFiles(hardlinkJobId, {
      leaseOwner: hardlinkOwner,
      leaseGeneration: 1,
    });
    await importTest.rollbackCreatedFiles(preexistingJobId, {
      leaseOwner: preexistingOwner,
      leaseGeneration: 1,
    });

    expect(existsSync(partialPath)).toBe(false);
    expect(getDb().query(
      "SELECT install_state FROM user_data_import_files WHERE job_id = ?",
    ).get(partialJobId)).toEqual({ install_state: "removed" });
    expect(existsSync(hardlinkPath)).toBe(false);
    expect(existsSync(sourcePath)).toBe(true);
    expect(getDb().query(
      "SELECT install_state FROM user_data_import_files WHERE job_id = ?",
    ).get(hardlinkJobId)).toEqual({ install_state: "removed" });
    expect(existsSync(preexistingPath)).toBe(true);
    expect(new Uint8Array(readFileSync(preexistingPath))).toEqual(sourceBytes);
    expect(getDb().query(
      "SELECT install_state FROM user_data_import_files WHERE job_id = ?",
    ).get(preexistingJobId)).toEqual({ install_state: "pending" });
  });
  test("imports a V1 descriptor-only notification sound with legacy defaults", async () => {
    const archivePath = join(workDir, "legacy-notification-sound.lvbak");
    const soundBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({ schemaVersion: 1, producer: "lumiverse" })),
        "files/notification-sounds/completion.mp3": soundBytes,
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(new Uint8Array(readFileSync(join(workDir, "notification-sounds", USER_ID, "completion.mp3"))))
      .toEqual(soundBytes);
  });

  test("rejects a legacy notification sound outside the descriptor allowlist", async () => {
    const archivePath = join(workDir, "legacy-notification-sound-invalid.lvbak");
    const soundBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({ schemaVersion: 1, producer: "lumiverse" })),
        "files/notification-sounds/other.mp3": soundBytes,
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/notification|completion/i);
  });

  test("round-trips a staged and committed artifact across owner roots", async () => {
    const destinationUserId = "artifact-destination-user";
    const characterId = "artifact-character";
    const chatId = "artifact-chat";
    const messageId = "artifact-message";
    const sourceArtifactId = "artifact-source";
    const turnId = "artifact-turn";
    const workspaceId = "artifact-workspace";
    const creatorToken = "artifact-creator";
    const artifactBytes = new Uint8Array([0x41, 0x72, 0x74, 0x69, 0x66, 0x61, 0x63, 0x74]);
    const digest = createHash("sha256").update(artifactBytes).digest("hex");
    const storagePath = `${digest}.blob`;
    const sourceArtifactRoot = join(workDir, "agent-artifacts");
    getDb().query(
      "INSERT INTO characters (id, name, user_id) VALUES (?, ?, ?)",
    ).run(characterId, "Artifact Character", USER_ID);
    getDb().query(
      "INSERT INTO chats (id, character_id, name, user_id) VALUES (?, ?, ?, ?)",
    ).run(chatId, characterId, "Artifact Chat", USER_ID);
    getDb().query(
      `INSERT INTO messages
       (id, chat_id, index_in_chat, is_user, name, content, swipe_id, swipes, extra)
       VALUES (?, ?, 0, 0, ?, ?, 0, ?, '{}')`,
    ).run(messageId, chatId, "assistant", "Artifact target", JSON.stringify(["Artifact target"]));
    getDb().query(
      `INSERT INTO agent_turn_executions
       (id, user_id, chat_id, generation_id, target_kind, target_message_id,
        target_chat_revision, target_message_revision, mode, runtime_epoch,
        deadline_at, state, root_ledger_json, frame_capabilities_json, commit_key, expires_at)
       VALUES (?, ?, ?, ?, 'normal', ?, 0, 0, 'agentic', 0, ?, 'WORK', '{}', '{}', ?, ?)`,
    ).run(turnId, USER_ID, chatId, "artifact-generation", messageId, Date.now() + 60_000, "artifact-commit", Math.floor(Date.now() / 1000) + 600);
    getDb().query(
      `INSERT INTO agent_turn_workspaces
       (workspace_id, turn_id, execution_id, user_id, chat_id, objective, constraints_json,
        state, revision, operation_caps_json, field_caps_json, retention, expires_at,
        quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_bytes)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 'active', 0, ?, '{}', 'chat_lifetime', ?, 4, 4, 4, 4, 1048576)`,
    ).run(
      workspaceId,
      turnId,
      turnId,
      USER_ID,
      chatId,
      "Artifact objective",
      JSON.stringify({ revision: 1, allowed: ["attach_artifact", "propose_publication"], maxOperationBytes: 131072, maxOperations: 128 }),
      Math.floor(Date.now() / 1000) + 600,
    );

    const store = new ArtifactBlobStore({ db: getDb(), rootDir: sourceArtifactRoot });
    const handle = await store.stageArtifact({
      userId: USER_ID,
      turnId,
      workspaceId,
      bytes: artifactBytes,
      digest,
      mimeType: "application/octet-stream",
      provenance: "root",
      retention: "chat_lifetime",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      fence: 1,
      assertFence: () => {},
      creatorToken,
    });
    expect(handle.storagePath).toBe(join(sourceArtifactRoot, USER_ID, storagePath));
    const attached = attachWorkspaceArtifactReference({
      userId: USER_ID,
      chatId,
      turnId,
      workspaceId,
      actor: "root",
      expectedRevision: 0,
      artifactId: sourceArtifactId,
      blobDigest: digest,
      byteCount: artifactBytes.byteLength,
      mimeType: "application/octet-stream",
      provenance: "root",
      creatorToken,
      taskId: null,
      retention: "chat_lifetime",
    });
    expect(attached.publicationState).toBe("attached");
    expect(proposeWorkspacePublication({
      userId: USER_ID,
      chatId,
      turnId,
      workspaceId,
      actor: "root",
      expectedRevision: 1,
      artifactId: sourceArtifactId,
    }).publicationState).toBe("proposed");
    const receipt = getDb().transaction(() => publishArtifactCommit(getDb(), {
      userId: USER_ID,
      chatId,
      turnId,
      executionId: turnId,
      workspaceId,
      commitKey: "artifact-commit",
      receiptId: "artifact-receipt",
      targetMessageId: messageId,
      targetSwipeId: 0,
      assertFence: () => {},
      refs: [{
        digest,
        byteCount: artifactBytes.byteLength,
        mimeType: "application/octet-stream",
        provenance: "root",
        retention: "chat_lifetime",
        messageId,
        swipeId: 0,
        workspaceArtifactId: sourceArtifactId,
      }],
    }))();
    expect(receipt.duplicate).toBe(false);
    const published = getDb().query(
      `SELECT published_artifact_id, storage_path
         FROM agent_published_workspace_artifacts
        WHERE user_id = ? AND blob_digest = ?`,
    ).get(USER_ID, digest) as { published_artifact_id: string; storage_path: string };
    expect(published.storage_path).toBe(storagePath);

    const archivePath = join(workDir, "artifact-round-trip.lvbak");
    const archiveBytes = await streamToBytes(
      buildExportStream({ userId: USER_ID, includeVectors: false, producerVersion: "test" }),
    );
    const archive = unzipSync(archiveBytes);
    const artifactEntries = Object.keys(archive).filter((name) => name.startsWith("files/artifacts/"));
    expect(artifactEntries).toEqual([`files/artifacts/${chatId}/${storagePath}`]);
    const publishedRowsEntry = Object.keys(archive).find((name) => name.endsWith("agent_published_workspace_artifacts.ndjson"));
    if (!publishedRowsEntry) throw new Error("published artifact canonical rows are missing from export");
    const publishedRows = new TextDecoder().decode(archive[publishedRowsEntry]!);
    expect(publishedRows).toContain(`"storage_path":"${storagePath}"`);
    expect(publishedRows).not.toContain(workDir);
    expect(Object.keys(archive).some((name) => name.includes("agent_artifact_blobs") || name.includes("agent_artifact_blob_journal") || name.includes("agent_workspace_artifacts"))).toBe(false);
    expect(new Set(Object.keys(archive)).size).toBe(Object.keys(archive).length);
    writeFileSync(archivePath, archiveBytes);

    const destinationRoot = mkdtempSync(join(tmpdir(), "lvbak-artifact-destination-"));
    closeDatabase();
    env.dataDir = destinationRoot;
    initDatabase(":memory:");
    await runMigrations(getDb());
    getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
      destinationUserId,
      "Artifact Destination",
      "artifact-destination@example.test",
    );
    const destinationArtifactPath = join(destinationRoot, "agent-artifacts", destinationUserId, storagePath);
    const job = await startImport({ userId: destinationUserId, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(existsSync(destinationArtifactPath)).toBe(true);
    expect(new Uint8Array(readFileSync(destinationArtifactPath))).toEqual(artifactBytes);
    expect(getDb().query(
      "SELECT final_path, install_state FROM user_data_import_files WHERE job_id = ? AND archive_path = ?",
    ).get(job.jobId, `files/artifacts/${chatId}/${storagePath}`)).toEqual({
      final_path: destinationArtifactPath,
      install_state: "installed",
    });
    expect(getDb().query(
      `SELECT user_id, source_artifact_id, message_id, swipe_id, storage_path, mime_type, byte_count, digest
         FROM agent_published_workspace_artifacts WHERE published_artifact_id = ?`,
    ).get(published.published_artifact_id)).toEqual({
      user_id: destinationUserId,
      source_artifact_id: sourceArtifactId,
      message_id: messageId,
      swipe_id: 0,
      storage_path: storagePath,
      mime_type: "application/octet-stream",
      byte_count: artifactBytes.byteLength,
      digest,
    });
    rmSync(destinationRoot, { recursive: true, force: true });
  });

  test("round-trips a ZIP64 export containing a record larger than 4 MiB", async () => {
    const archivePath = join(workDir, "exported.lvbak");
    const value = "x".repeat(5 * 1024 * 1024);
    getDb()
      .query("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 0)")
      .run("large_current_setting", value, USER_ID);
    writeFileSync(
      archivePath,
      await streamToBytes(
        buildExportStream({ userId: USER_ID, includeVectors: false, producerVersion: "test" }),
      ),
    );
    getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run("large_current_setting", USER_ID);

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb()
        .query("SELECT length(value) AS length FROM settings WHERE key = ? AND user_id = ?")
        .get("large_current_setting", USER_ID),
    ).toEqual({ length: value.length });
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

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb()
        .query("SELECT id, content, exclude_greeting, revision FROM world_book_entries ORDER BY id")
        .all(),
    ).toEqual([
      {
        id: "22222222-2222-2222-2222-222222222222",
        content: "first",
        exclude_greeting: 0,
        revision: 1,
      },
      {
        id: "33333333-3333-3333-3333-333333333333",
        content: "second",
        exclude_greeting: 0,
        revision: 1,
      },
    ]);
  });

  test("allows a ticket-waiting import to be cancelled", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "imports", USER_ID, jobId, "archive.lvbak");
    mkdirSync(join(workDir, "imports", USER_ID, jobId), { recursive: true });
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({ ...manifest(), hasEncryptedSecrets: true, secretsCount: 1 })),
        "secrets/index.json": strToU8(JSON.stringify({ keys: ["ticket-test-secret"] })),
        "secrets/encrypted.ndjson": strToU8(
          `${JSON.stringify({ key: "ticket-test-secret", iv: "AA==", tag: "AA==", ciphertext: "AA==" })}\n`,
        ),
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(job.jobId, "awaiting_ticket");
    expect(await cancelImportForUser("other-user", job.jobId)).toBe("not_found");
    expect(await cancelImportForUser(USER_ID, job.jobId)).toBe("cancelled");
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("cancelled");
    expect(await cancelImportForUser(USER_ID, job.jobId)).toBe("too_late");
  });
  test("restarts a parked encrypted import without GET reacquisition, then resumes skip", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "imports", USER_ID, jobId, "archive.lvbak");
    mkdirSync(join(workDir, "imports", USER_ID, jobId), { recursive: true });
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({ ...manifest(), hasEncryptedSecrets: true, secretsCount: 1 })),
        "secrets/index.json": strToU8(JSON.stringify({ keys: ["restart-ticket-secret"] })),
        "secrets/encrypted.ndjson": strToU8(
          `${JSON.stringify({ key: "restart-ticket-secret", iv: "AA==", tag: "AA==", ciphertext: "AA==" })}\n`,
        ),
      }),
    );
    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    const parkedBefore = getDb().query(
      "SELECT state, lease_owner, lease_expires_at, lease_generation FROM user_data_imports WHERE job_id = ?",
    ).get(jobId);
    expect(parkedBefore).toMatchObject({
      state: "awaiting_ticket",
      lease_owner: null,
      lease_expires_at: null,
    });

    importTest.forgetInMemoryJobForRestart(jobId);
    await reconcileUserDataImports();
    const statusAfterRestart = getJob(jobId);
    expect(statusAfterRestart?.status).toBe("awaiting_ticket");
    const parkedAfterStatus = getDb().query(
      "SELECT state, lease_owner, lease_expires_at, lease_generation FROM user_data_imports WHERE job_id = ?",
    ).get(jobId);
    expect(parkedAfterStatus).toEqual(parkedBefore);

    expect(await skipTicket(jobId)).toBe(true);
    const finished = await waitForTerminal(jobId);
    expect(finished.status).toBe("complete");
  });
  test("restarts a parked encrypted import and consumes its ticket after side-effect-free status", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "imports", USER_ID, jobId, "archive.lvbak");
    mkdirSync(join(workDir, "imports", USER_ID, jobId), { recursive: true });
    const created = await createTicket("restart-submit-archive", ["restart-submit-secret"]);
    const encrypted = await encryptSecret(created.smk, "restart-submit-secret", "plaintext");
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({
          ...manifest(),
          archiveId: created.ticket.archiveId,
          hasEncryptedSecrets: true,
          secretsCount: 1,
        })),
        "secrets/index.json": strToU8(JSON.stringify({ keys: ["restart-submit-secret"] })),
        "secrets/encrypted.ndjson": strToU8(`${JSON.stringify(encrypted)}\n`),
      }),
    );
    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    const parkedBefore = getDb().query(
      "SELECT state, lease_owner, lease_expires_at, lease_generation FROM user_data_imports WHERE job_id = ?",
    ).get(jobId);
    importTest.forgetInMemoryJobForRestart(jobId);
    await reconcileUserDataImports();
    expect(getJob(jobId)?.status).toBe("awaiting_ticket");
    expect(getDb().query(
      "SELECT state, lease_owner, lease_expires_at, lease_generation FROM user_data_imports WHERE job_id = ?",
    ).get(jobId)).toEqual(parkedBefore);

    await expect(submitTicket(jobId, created.ticket)).resolves.toEqual({ accepted: true });
    const finished = await waitForTerminal(jobId);
    expect(finished.status).toBe("complete");
    expect(getDb().query(
      "SELECT 1 AS present FROM secrets WHERE user_id = ? AND key = ?",
    ).get(USER_ID, "restart-submit-secret")).toEqual({ present: 1 });
  });
  test("racing production ticket submissions commits one graph and one receipt", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "imports", USER_ID, jobId, "archive.lvbak");
    mkdirSync(join(workDir, "imports", USER_ID, jobId), { recursive: true });
    const created = await createTicket("race-submit-archive", ["race-submit-secret"]);
    const encrypted = await encryptSecret(created.smk, "race-submit-secret", "plaintext");
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({
          ...manifest(),
          archiveId: created.ticket.archiveId,
          hasEncryptedSecrets: true,
          secretsCount: 1,
        })),
        "database/settings.ndjson": strToU8(
          `${JSON.stringify({ key: "race-submit-setting", value: "committed", user_id: "source", updated_at: 0 })}\n`,
        ),
        "secrets/index.json": strToU8(JSON.stringify({ keys: ["race-submit-secret"] })),
        "secrets/encrypted.ndjson": strToU8(`${JSON.stringify(encrypted)}\n`),
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    const zeroized: number[][] = [];
    importTest.setTicketZeroizationHook((smk) => zeroized.push([...smk]));
    const outcomes = await Promise.allSettled([
      submitTicket(jobId, created.ticket),
      submitTicket(jobId, created.ticket),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "replayed" });

    const finished = await waitForTerminal(job.jobId);
    expect(zeroized).toHaveLength(2);
    expect(zeroized.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(finished.status).toBe("complete");
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM settings WHERE user_id = ? AND key = ?",
    ).get(USER_ID, "race-submit-setting")).toEqual({ count: 1 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM secrets WHERE user_id = ? AND key = ?",
    ).get(USER_ID, "race-submit-secret")).toEqual({ count: 1 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM user_data_import_receipts WHERE job_id = ?",
    ).get(jobId)).toEqual({ count: 1 });
    expect(getDb().query(
      "SELECT archive_id, uses, user_id FROM import_consumed_tickets WHERE archive_id = ?",
    ).get(created.ticket.archiveId)).toEqual({
      archive_id: created.ticket.archiveId,
      uses: 1,
      user_id: USER_ID,
    });
  });
  test("rejects a stale ticket before decrypt and keeps the gate retryable", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "stale-ticket.lvbak");
    const created = await createTicket("stale-ticket-archive", ["stale-ticket-secret"]);
    await writeEncryptedTicketArchive(archivePath, created, "stale-ticket-secret");

    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    const staleTicket = {
      ...created.ticket,
      issuedAt: Math.floor(Date.now() / 1000) - TICKET_MAX_AGE_SECONDS - 1,
    };
    await expect(submitTicket(jobId, staleTicket)).rejects.toMatchObject({ code: "stale" });
    expect(getJob(jobId)?.status).toBe("awaiting_ticket");
    expect(getDb().query(
      "SELECT 1 FROM import_consumed_tickets WHERE archive_id = ?",
    ).get(created.ticket.archiveId)).toBeNull();

    await expect(submitTicket(jobId, created.ticket)).resolves.toEqual({ accepted: true });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(getDb().query(
      "SELECT 1 AS present FROM secrets WHERE user_id = ? AND key = ?",
    ).get(USER_ID, "stale-ticket-secret")).toEqual({ present: 1 });
  });

  test("zeroizes an accepted ticket when cancellation wins during file installation", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "accepted-install-cancel.lvbak");
    const installedPath = join(workDir, "notification-sounds", USER_ID, "completion.mp3");
    const created = await createTicket("accepted-install-cancel-archive", ["accepted-install-cancel-secret"]);
    await writeEncryptedTicketArchive(
      archivePath,
      created,
      "accepted-install-cancel-secret",
      { "files/notification-sounds/completion.mp3": new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
    );
    const zeroized: number[][] = [];
    importTest.setTicketZeroizationHook((smk) => zeroized.push([...smk]));
    let cancellation: Promise<unknown> | undefined;
    let syncCount = 0;
    importTest.setDirectorySyncHook(() => {
      if (syncCount++ === 0) cancellation = cancelImportForUser(USER_ID, jobId);
    });

    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    await expect(submitTicket(jobId, created.ticket)).resolves.toEqual({ accepted: true });
    expect(cancellation).toBeDefined();
    // Cancellation resolves only after creator-proof cleanup converges, so the
    // owner-scoped result is the terminal status, never a pending placeholder.
    expect(await cancellation).toBe("cancelled");
    const finished = await waitForTerminal(jobId);
    expect(finished.status).toBe("cancelled");
    expect(getDb().query("SELECT state FROM user_data_imports WHERE job_id = ?").get(jobId))
      .toEqual({ state: "cancelled" });
    expect(getDb().query("SELECT 1 FROM import_consumed_tickets WHERE archive_id = ?").get(created.ticket.archiveId))
      .toBeNull();
    expect(existsSync(installedPath)).toBe(false);
    expect(zeroized).toHaveLength(1);
    expect(zeroized[0].every((byte) => byte === 0)).toBe(true);
    expect(getJob(jobId)?.acceptedTicket).toBeUndefined();
    expect(getJob(jobId)?.ticketGate).toBeUndefined();
    expect(getJob(jobId)?.ticketResolver).toBeUndefined();
  });

  test("zeroizes an accepted ticket after an installed-file conflict", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "accepted-conflict.lvbak");
    const soundPath = join(workDir, "notification-sounds", USER_ID, "completion.mp3");
    const soundBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    mkdirSync(join(workDir, "notification-sounds", USER_ID), { recursive: true });
    writeFileSync(soundPath, new Uint8Array([9, 8, 7]));
    const created = await createTicket("accepted-conflict-archive", ["accepted-conflict-secret"]);
    await writeEncryptedTicketArchive(
      archivePath,
      created,
      "accepted-conflict-secret",
      { "files/notification-sounds/completion.mp3": soundBytes },
    );
    const zeroized: number[][] = [];
    importTest.setTicketZeroizationHook((smk) => zeroized.push([...smk]));

    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    await expect(submitTicket(jobId, created.ticket)).resolves.toEqual({ accepted: true });
    const finished = await waitForTerminal(jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("pre-existing file digest mismatch");
    expect(getDb().query("SELECT 1 FROM import_consumed_tickets WHERE archive_id = ?").get(created.ticket.archiveId))
      .toBeNull();
    expect(new Uint8Array(readFileSync(soundPath))).toEqual(new Uint8Array([9, 8, 7]));
    expect(zeroized).toHaveLength(1);
    expect(zeroized[0].every((byte) => byte === 0)).toBe(true);
    expect(getJob(jobId)?.acceptedTicket).toBeUndefined();
    expect(getJob(jobId)?.ticketGate).toBeUndefined();
    expect(getJob(jobId)?.ticketResolver).toBeUndefined();
  });

  test("zeroizes an accepted ticket after a pre-commit capacity failure", async () => {
    const jobId = crypto.randomUUID();
    const archivePath = join(workDir, "accepted-capacity-failure.lvbak");
    const created = await createTicket("accepted-capacity-archive", ["accepted-capacity-secret"]);
    await writeEncryptedTicketArchive(archivePath, created, "accepted-capacity-secret");
    const zeroized: number[][] = [];
    importTest.setTicketZeroizationHook((smk) => zeroized.push([...smk]));
    importTest.setFilesystemCapacityHook(() => ({ bavail: 0, bsize: 4096 }));

    const job = await startImport({ userId: USER_ID, archivePath, jobId });
    await waitForStatus(jobId, "awaiting_ticket");
    await expect(submitTicket(jobId, created.ticket)).resolves.toEqual({ accepted: true });
    const finished = await waitForTerminal(jobId);
    expect(finished.status).toBe("failed");
    expect(getDb().query("SELECT state FROM user_data_imports WHERE job_id = ?").get(jobId))
      .toEqual({ state: "failed" });
    expect(getDb().query("SELECT 1 FROM import_consumed_tickets WHERE archive_id = ?").get(created.ticket.archiveId))
      .toBeNull();
    expect(zeroized).toHaveLength(1);
    expect(zeroized[0].every((byte) => byte === 0)).toBe(true);
    expect(getJob(jobId)?.acceptedTicket).toBeUndefined();
    expect(getJob(jobId)?.ticketGate).toBeUndefined();
    expect(getJob(jobId)?.ticketResolver).toBeUndefined();
  });
  test("keeps a consumed archive tombstone across account deletion and recreation", () => {
    const archiveId = "account-delete-ticket-tombstone";
    getDb().query(
      "INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses) VALUES (?, ?, ?, 1)",
    ).run(archiveId, 1, USER_ID);
    getDb().query('DELETE FROM "user" WHERE id = ?').run(USER_ID);
    expect(getDb().query(
      "SELECT archive_id, user_id, uses FROM import_consumed_tickets WHERE archive_id = ?",
    ).get(archiveId)).toEqual({ archive_id: archiveId, user_id: null, uses: 1 });

    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(USER_ID, "Recreated User", "recreated@example.com", 0, 0);
    expect(getDb().query(
      "SELECT archive_id, user_id, uses FROM import_consumed_tickets WHERE archive_id = ?",
    ).get(archiveId)).toEqual({ archive_id: archiveId, user_id: null, uses: 1 });
  });

  test("returns too_late for an owner after terminal relational commit", async () => {
    const archivePath = join(workDir, "terminal-cancel.lvbak");
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest())),
      }),
    );
    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(await cancelImportForUser(USER_ID, job.jobId)).toBe("too_late");
    expect(await cancelImportForUser("other-user", job.jobId)).toBe("not_found");
  });

  test("enforces a smaller NDJSON ceiling advertised by a legacy manifest", async () => {
    const archivePath = join(workDir, "legacy-advertised-line-cap.lvbak");
    const row = `${JSON.stringify({
      key: "legacy_cap",
      value: "x".repeat(256),
      user_id: "source-user",
      updated_at: 0,
    })}\n`;
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({
          schemaVersion: 1,
          producer: "lumiverse",
          ndjsonMaxRecordBytes: 128,
        })),
        "database/settings.ndjson": strToU8(row),
      }),
    );
    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("NDJSON line exceeds");
  });

  test("rejects a V2 NDJSON record at the cap plus one byte", async () => {
    const archivePath = join(workDir, "v2-oversized-line.lvbak");
    const oversized = new Uint8Array(NDJSON_MAX_RECORD_BYTES + 1);
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest())),
        "database/settings.ndjson": oversized,
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("NDJSON line exceeds");
  });
  test("accepts a record exactly at the V2/V3 NDJSON cap and rejects cap plus one", () => {
    const stagingPath = join(workDir, "record-cap.ndjson");
    const prefix = '{"value":"';
    const suffix = '"}';
    const valueBytes = NDJSON_MAX_RECORD_BYTES - Buffer.byteLength(prefix + suffix);
    const row = `${prefix}${"x".repeat(valueBytes)}${suffix}`;
    expect(Buffer.byteLength(row)).toBe(NDJSON_MAX_RECORD_BYTES);
    writeFileSync(stagingPath, `${row}\n`);
    expect(Array.from(importTest.readNdjsonEntriesSync(stagingPath, NDJSON_MAX_RECORD_BYTES))).toHaveLength(1);
    writeFileSync(stagingPath, `${row}x\n`);
    expect(() => Array.from(importTest.readNdjsonEntriesSync(stagingPath, NDJSON_MAX_RECORD_BYTES))).toThrow(
      `NDJSON line exceeds ${NDJSON_MAX_RECORD_BYTES} bytes`,
    );
  });
  test("rejects SQLite-affinity coercion and enforces scalar storage checks", () => {
    expect(() => importTest.normalizeSqlValue(1.5, "INTEGER")).toThrow("unsafe integer");
    expect(() => importTest.normalizeSqlValue(Number.MAX_SAFE_INTEGER + 1, "INTEGER")).toThrow("unsafe integer");
    expect(() => importTest.normalizeSqlValue(Number.MAX_SAFE_INTEGER * 2, "REAL")).toThrow("out-of-range");
    expect(() => importTest.normalizeSqlValue(1, "TEXT")).toThrow("non-string");
    expect(() => importTest.normalizeSqlValue("not-base64", "BLOB")).toThrow("base64");
    expect(importTest.normalizeSqlValue("AQI=", "BLOB")).toEqual(new Uint8Array([1, 2]));
    const oversizedBlob = "A".repeat(Math.ceil(importTest.maxSqlBlobBytes / 3) * 4 + 4);
    expect(() => importTest.normalizeSqlValue(oversizedBlob, "BLOB")).toThrow("base64");

    const live = new Database(":memory:");
    const stage = new Database(":memory:");
    live.run("CREATE TABLE scalar_fixture (id INTEGER PRIMARY KEY, count INTEGER, score REAL, label TEXT, payload BLOB)");
    importTest.createStagedTable(stage, live, "scalar_fixture");
    expect(() => stage.query("INSERT INTO scalar_fixture VALUES (?, ?, ?, ?, ?)").run(
      1,
      Number.MAX_SAFE_INTEGER + 1,
      0.5,
      "ok",
      new Uint8Array([1]),
    )).toThrow();
    expect(() => stage.query("INSERT INTO scalar_fixture VALUES (?, ?, ?, ?, ?)").run(
      2,
      2,
      Number.MAX_SAFE_INTEGER * 2,
      "ok",
      new Uint8Array([1]),
    )).toThrow();
    expect(() => stage.query("INSERT INTO scalar_fixture VALUES (?, ?, ?, ?, ?)").run(
      3,
      2,
      0.5,
      "ok",
      "AQI=",
    )).toThrow();
    stage.query("INSERT INTO scalar_fixture VALUES (?, ?, ?, ?, ?)").run(
      4,
      2,
      0.5,
      "ok",
      new Uint8Array([1, 2]),
    );
    expect(stage.query("SELECT typeof(count) AS count_type, typeof(score) AS score_type, typeof(label) AS label_type, typeof(payload) AS payload_type FROM scalar_fixture WHERE id = 4").get()).toEqual({
      count_type: "integer",
      score_type: "real",
      label_type: "text",
      payload_type: "blob",
    });
    stage.close();
    live.close();
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

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb()
        .query("SELECT length(value) AS length FROM settings WHERE key = ? AND user_id = ?")
        .get("legacy_large_setting", USER_ID),
    ).toEqual({ length: value.length });
  });
  test("rejects a V3 manifest with a stale archive registry version", async () => {
    const binaryJournalPath = join(workDir, "stale-registry.ndjson");
    writeFileSync(binaryJournalPath, "");
    await expect(
      importTest.validateManifestEntries(
        {
          ...manifest(),
          schemaVersion: 3,
          embeddingIdentity: "test-embedding",
          vectorStatus: "rebuild_required",
          registryVersion: 2,
          snapshotId: "snapshot-stale-registry",
          fileAliases: [],
          missingOptionalFiles: [],
          byteCounts: {},
          entries: [],
        },
        { entries: [], binaryJournalPath },
      ),
    ).rejects.toThrow("archive registry version is not supported");
  });
  test("rejects a V3 manifest that omits an empty canonical table payload", async () => {
    const binaryJournalPath = join(workDir, "empty-binary-journal.ndjson");
    writeFileSync(binaryJournalPath, "");
    const v3Manifest = {
      ...manifest(),
      schemaVersion: 3,
      embeddingIdentity: "test-embedding",
      vectorStatus: "rebuild_required",
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: "snapshot-empty-canonical",
      fileAliases: [],
      byteCounts: {},
      missingOptionalFiles: [],
      entries: [],
    };
    await expect(
      importTest.validateManifestEntries(v3Manifest, {
        entries: [],
        binaryJournalPath,
      }),
    ).rejects.toThrow("canonical table payload is missing");
  });
  test("rejects V3 canonical requiredness and row-count mismatches", async () => {
    const stagingPath = join(workDir, "settings.ndjson");
    const binaryJournalPath = join(workDir, "binary-journal.ndjson");
    const payload = `${JSON.stringify({ key: "integrity", value: "1", user_id: "source", updated_at: 0 })}\n`;
    writeFileSync(stagingPath, payload);
    writeFileSync(binaryJournalPath, "");
    const bytes = Buffer.byteLength(payload);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const actual = {
      kind: "text" as const,
      table: "settings",
      origin: "database" as const,
      stagingPath,
      byteSize: bytes,
    };
    await expect(
      importTest.validateManifestEntries(
        {
          ...manifest(),
          schemaVersion: 3,
          embeddingIdentity: "test-embedding",
          vectorStatus: "rebuild_required",
          registryVersion: ARCHIVE_REGISTRY_VERSION,
          snapshotId: "snapshot-required",
          counts: { settings: 1 },
          fileAliases: [],
          missingOptionalFiles: [],
          byteCounts: { "database/settings.ndjson": bytes },
          entries: [{ path: "database/settings.ndjson", kind: "database", required: false, bytes, sha256, rowCount: 1 }],
        },
        { entries: [actual], binaryJournalPath },
      ),
    ).rejects.toThrow("canonical table payload must be required");
    await expect(
      importTest.validateManifestEntries(
        {
          ...manifest(),
          schemaVersion: 3,
          embeddingIdentity: "test-embedding",
          vectorStatus: "rebuild_required",
          registryVersion: ARCHIVE_REGISTRY_VERSION,
          snapshotId: "snapshot-row-count",
          counts: { settings: 2 },
          fileAliases: [],
          missingOptionalFiles: [],
          byteCounts: { "database/settings.ndjson": bytes },
          entries: [{ path: "database/settings.ndjson", kind: "database", required: true, bytes, sha256, rowCount: 2 }],
        },
        { entries: [actual], binaryJournalPath },
      ),
    ).rejects.toThrow("canonical table row count mismatch");
  });

  test("enforces the shared frozen-file ceiling without allocating the ceiling", async () => {
    const stagingPath = join(workDir, "empty.ndjson");
    const binaryJournalPath = join(workDir, "binary-journal.ndjson");
    writeFileSync(stagingPath, "");
    writeFileSync(binaryJournalPath, "");
    await expect(
      importTest.validateManifestEntries(
        {
          ...manifest(),
          schemaVersion: 3,
          embeddingIdentity: "test-embedding",
          vectorStatus: "rebuild_required",
          registryVersion: ARCHIVE_REGISTRY_VERSION,
          snapshotId: "snapshot-cap",
          counts: { settings: 0 },
          fileAliases: [],
          missingOptionalFiles: [],
          byteCounts: { "database/settings.ndjson": MAX_ARCHIVE_FILE_BYTES + 1 },
          entries: [{
            path: "database/settings.ndjson",
            kind: "database",
            required: true,
            bytes: MAX_ARCHIVE_FILE_BYTES + 1,
            sha256: createHash("sha256").update("").digest("hex"),
            rowCount: 0,
          }],
        },
        {
          entries: [{
            kind: "text",
            table: "settings",
            origin: "database",
            stagingPath,
            byteSize: 0,
          }],
          binaryJournalPath,
        },
      ),
    ).rejects.toThrow(`${MAX_ARCHIVE_FILE_BYTES} bytes`);
  });
  test("fails closed for directory durability errors while allowing unsupported fsync", () => {
    const makeError = (code: string): Error => {
      const error = new Error(code);
      Object.defineProperty(error, "code", { value: code });
      return error;
    };
    try {
      importTest.setDirectorySyncHook(() => {
        throw makeError("EIO");
      });
      expect(() => importTest.syncDirectory(workDir)).toThrow("EIO");
      importTest.setDirectorySyncHook(() => {
        throw makeError("ENOTSUP");
      });
      expect(() => importTest.syncDirectory(workDir)).not.toThrow();
    } finally {
      importTest.setDirectorySyncHook(null);
    }
  });

  test("rejects invalid staged audio before installation", () => {
    const audioPath = join(workDir, "invalid.mp3");
    writeFileSync(audioPath, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(() => importTest.assertAudioPayload(audioPath, "files/audio/invalid.mp3")).toThrow("does not match extension");
  });

  test("imports an oversized record from a format-1 archive whose 4 MiB claim was unenforced", async () => {
    const archivePath = join(workDir, "format-v1-oversized-line.lvbak");
    const value = "y".repeat(5 * 1024 * 1024);
    const row = JSON.stringify({
      key: "format_v1_large_setting",
      value,
      user_id: "source-user",
      updated_at: 0,
    });
    writeFileSync(
      archivePath,
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({ ...manifest({ modern: false }), ndjsonFormatVersion: 1 }),
        ),
        "database/settings.ndjson": strToU8(`${row}\n`),
      }),
    );

    const job = await startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
    const finished = await waitForTerminal(job.jobId);
    expect(finished.status).toBe("complete");
    expect(
      getDb()
        .query("SELECT length(value) AS length FROM settings WHERE key = ? AND user_id = ?")
        .get("format_v1_large_setting", USER_ID),
    ).toEqual({ length: value.length });
  });

});
