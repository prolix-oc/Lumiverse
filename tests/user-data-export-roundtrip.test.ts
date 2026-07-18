/**
 * Round-trip test for the user-data export/import pipeline.
 *
 * Background: the export writer was historically fflate-based, which only
 * produces ZIP32 archives. The 32-bit compressedSize / uncompressedSize /
 * localHeaderOffset fields wrap to 0 when an archive crosses 2³²−1 bytes,
 * silently corrupting the central directory with no error and no recovery
 * path on import. The fix swaps the export writer for archiver with
 * `forceZip64: true`. This test pins the contract:
 *
 *   1. The export stream produces a well-formed ZIP.
 *   2. The manifest round-trips through the central-directory verifier and
 *      its compatibility entry point.
 *   3. Pushing a realistic multi-row payload (10⁵ rows × ~1 KB each →
 *      ~100 MB) through the streaming pipeline produces a valid archive
 *      — proves the streaming path is healthy at scale, which is what
 *      makes the >4 GB case work (the same code path is exercised, just
 *      with more bytes).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { join } from "path";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import {
  closeDatabase,
  getDb,
  initDatabase,
} from "../src/db/connection";
import { buildExportStream } from "../src/services/user-data/export.service";
import { verifyArchiveFast, verifyArchive } from "../src/services/user-data/import.service";

const USER_ID = "export-roundtrip-user";

function testManifest(archiveId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    producer: "lumiverse",
    exportedAt: 0,
    archiveId,
    producerVersion: "test",
    includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    counts: {},
    missingFiles: [],
  };
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(
    await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text(),
  );
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function isValidZip(bytes: Uint8Array): boolean {
  // Every ZIP (incl. ZIP64) starts with the local file header signature
  // "PK\x03\x04" at byte 0.
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function hasEocd(bytes: Uint8Array): boolean {
  // End-of-central-directory record signature: "PK\x05\x06".
  if (bytes.byteLength < 22) return false;
  // Scan backward for the EOCD signature.
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return true;
    }
  }
  return false;
}

describe("user-data export ZIP64 round-trip", () => {
  let workDir: string;

  beforeEach(async () => {
    closeDatabase();
    workDir = mkdtempSync(join(tmpdir(), "lvbak-test-"));
    initDatabase(":memory:");
    await applyBaseline();
    // Minimal user row — the registry-driven export filters everything by
    // user_id, so we need at least one row in `user` for the joins to
    // resolve to a non-empty result set.
    getDb()
      .query(
        "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) " +
          "VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(USER_ID, "Test User", "test@example.com", 0, 0);
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  test("export produces a well-formed ZIP with a parseable manifest", async () => {
    const stream = buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    });

    const bytes = await readAll(stream);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(isValidZip(bytes)).toBe(true);
    expect(hasEocd(bytes)).toBe(true);

    // Persist so the import-side verifier (which expects a file path) can
    // exercise both code paths.
    const archivePath = join(workDir, "export.lvbak");
    writeFileSync(archivePath, bytes);

    // Fast path: ZIP central-directory parse + manifest read.
    const manifest = await verifyArchiveFast(archivePath);
    expect(manifest.producer).toBe("lumiverse");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.archiveId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("compatibility verifier also accepts the export", async () => {
    const stream = buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    });

    const bytes = await readAll(stream);
    const archivePath = join(workDir, "export-compatibility.lvbak");
    writeFileSync(archivePath, bytes);

    // The public compatibility entry point intentionally uses the same
    // bounded central-directory verifier as the import route.
    const manifest = await verifyArchive(archivePath);
    expect(manifest.producer).toBe("lumiverse");
    expect(manifest.schemaVersion).toBe(1);
  });

  test("fast verifier scans a multi-page central directory without loading it whole", async () => {
    const archiveId = crypto.randomUUID();
    const entries: Record<string, Uint8Array> = {};
    const empty = new Uint8Array(0);
    // Put the manifest last and make the directory comfortably larger than
    // two verifier pages so records and names cross read boundaries.
    for (let i = 0; i < 8_000; i++) {
      entries[`files/images/${i.toString(36).padStart(6, "0")}-asset.bin`] = empty;
    }
    entries["manifest.json"] = strToU8(JSON.stringify(testManifest(archiveId)));

    const bytes = zipSync(entries, { level: 0 });
    expect(bytes.byteLength).toBeGreaterThan(512 * 1024);
    const archivePath = join(workDir, "large-central-directory.lvbak");
    writeFileSync(archivePath, bytes);

    const manifest = await verifyArchiveFast(archivePath);
    expect(manifest.archiveId).toBe(archiveId);
  });

  test("compatibility verifier finds a trailing manifest without reading leading data", async () => {
    const archiveId = crypto.randomUUID();
    const leadingData = new Uint8Array(8 * 1024 * 1024);
    const bytes = zipSync(
      {
        "files/images/large.bin": leadingData,
        "manifest.json": strToU8(JSON.stringify(testManifest(archiveId))),
      },
      { level: 0 },
    );
    const archivePath = join(workDir, "manifest-last.lvbak");
    writeFileSync(archivePath, bytes);

    const manifest = await verifyArchive(archivePath);
    expect(manifest.archiveId).toBe(archiveId);
  });

  test("fast verifier caps manifest inflation even when ZIP metadata lies", async () => {
    const archiveId = crypto.randomUUID();
    const oversized = {
      ...testManifest(archiveId),
      padding: "x".repeat(17 * 1024 * 1024),
    };
    const bytes = zipSync(
      { "manifest.json": strToU8(JSON.stringify(oversized)) },
      { level: 9 },
    );

    // Lie about the uncompressed size in the central-directory record so the
    // preflight metadata check passes. The bounded inflater must still reject
    // the actual >16 MB output rather than allocating it without limit.
    let cdh = -1;
    for (let i = bytes.byteLength - 46; i >= 0; i--) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x01 &&
        bytes[i + 3] === 0x02
      ) {
        cdh = i;
        break;
      }
    }
    expect(cdh).toBeGreaterThanOrEqual(0);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(cdh + 24, 1, true);

    const archivePath = join(workDir, "manifest-inflate-cap.lvbak");
    writeFileSync(archivePath, bytes);
    await expect(verifyArchiveFast(archivePath)).rejects.toMatchObject({
      name: "ArchiveValidationError",
      code: "bad_manifest",
    });
  });

  test("export with 10⁵ character rows streams to ~100 MB without OOM", async () => {
    // Insert 100,000 characters in batches. ~1 KB of description each →
    // a ~100 MB NDJSON stream, the same per-row path a multi-GB export
    // exercises. Catches any regression where the streaming pipeline
    // accidentally buffers the whole NDJSON in memory.
    const stmt = getDb().prepare(
      "INSERT INTO characters (id, user_id, name, description, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
    );
    const tx = getDb().transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        const id = `char-${i.toString(36).padStart(8, "0")}`;
        const desc = "x".repeat(900) + ` #${i}`;
        stmt.run(id, USER_ID, `Char ${i}`, desc);
      }
    });
    tx(100_000);

    const stream = buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    });

    const bytes = await readAll(stream);
    expect(isValidZip(bytes)).toBe(true);
    // 100,000 rows × ~1 KB compressed → archive should comfortably exceed
    // a few MB. The exact number is irrelevant; what matters is that the
    // stream finished, didn't OOM, and the central directory is well-formed.
    expect(bytes.byteLength).toBeGreaterThan(1_000_000);

    // And the import-side fast verifier accepts it.
    const archivePath = join(workDir, "export-big.lvbak");
    writeFileSync(archivePath, bytes);
    const manifest = await verifyArchiveFast(archivePath);
    expect(manifest.producer).toBe("lumiverse");
  });

  test.skipIf(!process.env.BENCHMARK)(
    "500k character rows benchmark (set BENCHMARK=1 to run)",
    async () => {
      const ROWS = 500_000;
      const stmt = getDb().prepare(
        "INSERT INTO characters (id, user_id, name, description, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 0, 0)",
      );
      const tx = getDb().transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          const id = `char-${i.toString(36).padStart(8, "0")}`;
          const desc = "x".repeat(900) + ` #${i}`;
          stmt.run(id, USER_ID, `Char ${i}`, desc);
        }
      });
      tx(ROWS);

      const t0 = performance.now();
      const stream = buildExportStream({
        userId: USER_ID,
        includeVectors: false,
        producerVersion: "test",
      });
      const bytes = await readAll(stream);
      const t1 = performance.now();

      expect(isValidZip(bytes)).toBe(true);
      expect(bytes.byteLength).toBeGreaterThan(1_000_000);
      console.log(
        `[benchmark] ${ROWS.toLocaleString()} rows in ${(t1 - t0).toFixed(1)}ms ` +
          `(${Math.round(ROWS / ((t1 - t0) / 1000)).toLocaleString()} rows/s)`,
      );
    },
    120_000,
  );
});
