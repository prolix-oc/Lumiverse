import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { runMigrations } from "../../db/migrate";
import { env } from "../../env";
import {
  __test__,
  getJob,
  startImport,
  type ImportJob,
} from "./import.service";
import {
  ARCHIVE_REGISTRY_VERSION,
  ARCHIVE_TABLE_REGISTRY,
  buildArchiveOwnerPredicate,
  getArchiveTableSpec,
  getCanonicalImportOrder,
} from "./table-registry";
import {
  ARCHIVE_PRODUCER,
  ARCHIVE_SCHEMA_VERSION,
  NDJSON_FORMAT_VERSION,
  NDJSON_MAX_RECORD_BYTES,
  parseManifest,
  type ArchiveEntry,
  type ArchiveManifest,
} from "./manifest";
import { sanitizeEntry } from "./sanitize";

const roots: string[] = [];
let databaseDataDir: string | null = null;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type StoredZipEntry = {
  name: string;
  data: Uint8Array;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
};

/** Build a tiny stored ZIP without allocating a whole archive library. */
function storedZip(entries: readonly StoredZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const entryCrc = entry.crc ?? crc32(data);
    const compressedSize = entry.compressedSize ?? data.byteLength;
    const uncompressedSize = entry.uncompressedSize ?? data.byteLength;
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(entryCrc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(entryCrc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.byteLength + data.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const localDirectory = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(localDirectory.byteLength, 16);
  return Buffer.concat([localDirectory, centralDirectory, eocd]);
}

function legacyManifest(schemaVersion: 1 | 2): string {
  return JSON.stringify({
    producer: ARCHIVE_PRODUCER,
    schemaVersion,
    archiveId: `archive-v${schemaVersion}`,
    exportedAt: 0,
    producerVersion: null,
    includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    counts: {},
    missingFiles: [],
    hasEncryptedSecrets: false,
    secretsCount: 0,
  });
}

function v3Manifest(entry: ArchiveEntry): ArchiveManifest {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    producer: ARCHIVE_PRODUCER,
    exportedAt: 0,
    archiveId: "archive-v3",
    producerVersion: null,
    ndjsonFormatVersion: NDJSON_FORMAT_VERSION,
    ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
    includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    embeddingIdentity: null,
    vectorStatus: "rebuild_required",
    registryVersion: ARCHIVE_REGISTRY_VERSION,
    snapshotId: "snapshot-1",
    entries: [entry],
    fileAliases: [],
    counts: {},
    byteCounts: { [entry.path]: entry.bytes },
    missingFiles: [],
    missingOptionalFiles: [],
    hasEncryptedSecrets: false,
    secretsCount: 0,
  };
}

async function waitForTerminal(jobId: string): Promise<ImportJob> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = getJob(jobId);
    if (job && (job.status === "complete" || job.status === "failed" || job.status === "cancelled")) return job;
    await Bun.sleep(5);
  }
  throw new Error(`import job did not settle: ${jobId}`);
}

async function setupImportDatabase(): Promise<string> {
  closeDatabase();
  const root = await mkdtemp(join(tmpdir(), "lumiverse-archive-contract-"));
  roots.push(root);
  databaseDataDir = env.dataDir;
  env.dataDir = root;
  initDatabase(":memory:");
  await runMigrations(getDb());
  getDb().query(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  ).run("archive-import-user", "Archive Import", "archive-import@example.com", 0, 0);
  return root;
}

afterEach(async () => {
  if (databaseDataDir !== null) {
    closeDatabase();
    env.dataDir = databaseDataDir;
    databaseDataDir = null;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hostile ZIP compatibility", () => {
  test("rejects V1 payload CRC corruption before any relational apply", async () => {
    const root = await setupImportDatabase();
    const payload = Buffer.from("corrupt-payload");
    const archivePath = join(root, "crc.lvbak");
    await writeFile(archivePath, storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(1)) },
      {
        name: "files/audio/00000000-0000-0000-0000-000000000000.mp3",
        data: payload,
        crc: crc32(Buffer.from("different-payload")),
      },
    ]));

    const job = await startImport({
      userId: "archive-import-user",
      archivePath,
      jobId: "crc-corruption",
    });
    const settled = await waitForTerminal(job.jobId);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/CRC32 disagrees with central directory/);
    expect(getDb().query("SELECT COUNT(*) AS count FROM chats").get()).toEqual({ count: 0 });
  });

  test("rejects V2 payload length corruption against the ZIP central directory", async () => {
    const root = await setupImportDatabase();
    const archivePath = join(root, "length.lvbak");
    await writeFile(archivePath, storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(2)) },
      {
        name: "files/audio/00000000-0000-0000-0000-000000000000.bin",
        data: Buffer.from("three"),
        uncompressedSize: 99,
      },
    ]));

    const job = await startImport({
      userId: "archive-import-user",
      archivePath,
      jobId: "length-corruption",
    });
    const settled = await waitForTerminal(job.jobId);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/size disagrees with central directory/);
    expect(getDb().query("SELECT COUNT(*) AS count FROM chats").get()).toEqual({ count: 0 });
  });

  test("rejects central-directory trailing bytes after the declared entry", async () => {
    const root = await setupImportDatabase();
    const archivePath = join(root, "central-trailing.lvbak");
    const archive = storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(1)) },
    ]);
    const eocdOffset = archive.byteLength - 22;
    const centralSize = archive.readUInt32LE(eocdOffset + 12);
    const withTrailingByte = Buffer.concat([
      archive.subarray(0, eocdOffset),
      Buffer.from([0]),
      archive.subarray(eocdOffset),
    ]);
    withTrailingByte.writeUInt32LE(centralSize + 1, eocdOffset + 1 + 12);
    await writeFile(archivePath, withTrailingByte);

    const job = await startImport({
      userId: "archive-import-user",
      archivePath,
      jobId: "central-trailing",
    });
    const settled = await waitForTerminal(job.jobId);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/central directory contains trailing bytes/);
  });
  test("rejects a hidden gap between the central directory and EOCD", async () => {
    const root = await setupImportDatabase();
    const archivePath = join(root, "central-gap.lvbak");
    const archive = storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(1)) },
    ]);
    const eocdOffset = archive.byteLength - 22;
    const withGap = Buffer.concat([
      archive.subarray(0, eocdOffset),
      Buffer.from([0]),
      archive.subarray(eocdOffset),
    ]);
    await writeFile(archivePath, withGap);

    const job = await startImport({
      userId: "archive-import-user",
      archivePath,
      jobId: "central-gap",
    });
    const settled = await waitForTerminal(job.jobId);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/central directory contains trailing bytes/);
  });

  test("rejects a hidden central-directory entry outside the declared range", async () => {
    const root = await setupImportDatabase();
    const archivePath = join(root, "central-hidden-entry.lvbak");
    const archive = storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(1)) },
    ]);
    const hiddenName = "database/hidden.ndjson";
    const hiddenArchive = storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(1)) },
      { name: hiddenName, data: Buffer.from("{}\n") },
    ]);
    const hiddenEocdOffset = hiddenArchive.byteLength - 22;
    const hiddenCentralOffset = hiddenArchive.readUInt32LE(hiddenEocdOffset + 16);
    const hiddenCentralSize = hiddenArchive.readUInt32LE(hiddenEocdOffset + 12);
    const hiddenRecordOffset = hiddenCentralOffset + 46 + Buffer.byteLength("manifest.json");
    const hiddenRecord = hiddenArchive.subarray(
      hiddenRecordOffset,
      hiddenCentralOffset + hiddenCentralSize,
    );
    const eocdOffset = archive.byteLength - 22;
    await writeFile(
      archivePath,
      Buffer.concat([
        archive.subarray(0, eocdOffset),
        hiddenRecord,
        archive.subarray(eocdOffset),
      ]),
    );

    const job = await startImport({
      userId: "archive-import-user",
      archivePath,
      jobId: "central-hidden-entry",
    });
    const settled = await waitForTerminal(job.jobId);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/central directory contains trailing bytes/);
  });

  test("retains the bounded V1 manifest-stats compatibility trailer", async () => {
    const root = await setupImportDatabase();
    const archivePath = join(root, "v1-stats.lvbak");
    await writeFile(archivePath, storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(1)) },
      {
        name: "manifest-stats.json",
        data: Buffer.from(JSON.stringify({
          counts: { chats: 3 },
          missingFiles: ["files/notification-sounds/missing.mp3"],
        })),
      },
    ]));

    const job = await startImport({
      userId: "archive-import-user",
      archivePath,
      jobId: "v1-stats",
    });
    const settled = await waitForTerminal(job.jobId);
    expect(settled.status).toBe("complete");
    expect(settled.manifest?.counts).toEqual({ chats: 3 });
    expect(settled.manifest?.missingFiles).toEqual(["files/notification-sounds/missing.mp3"]);
  });

  test("rejects a central-directory entry-count mismatch", async () => {
    const root = await setupImportDatabase();
    const archivePath = join(root, "central-count.lvbak");
    const archive = storedZip([
      { name: "manifest.json", data: Buffer.from(legacyManifest(1)) },
    ]);
    const eocdOffset = archive.byteLength - 22;
    archive.writeUInt16LE(2, eocdOffset + 8);
    archive.writeUInt16LE(2, eocdOffset + 10);
    await writeFile(archivePath, archive);

    const job = await startImport({
      userId: "archive-import-user",
      archivePath,
      jobId: "central-count",
    });
    const settled = await waitForTerminal(job.jobId);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/central directory entry count mismatch/);
  });
});

describe("V3 authenticated entry ledger", () => {
  test("rejects staged payload SHA-256 mismatch before canonical-table checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumiverse-archive-v3-sha-"));
    roots.push(root);
    const payload = Buffer.from("stable-audio");
    const payloadPath = join(root, "payload.bin");
    const journalPath = join(root, "binary.ndjson");
    await writeFile(payloadPath, payload);
    await writeFile(journalPath, `${JSON.stringify({
      kind: "binary",
      bucket: "audio",
      inner: "00000000-0000-0000-0000-000000000000.bin",
      stagingPath: payloadPath,
      byteSize: payload.byteLength,
    })}\n`);
    const entry = {
      path: "files/audio/00000000-0000-0000-0000-000000000000.bin",
      kind: "file" as const,
      required: false,
      bytes: payload.byteLength,
      sha256: "0".repeat(64),
      sourceIdentity: { device: 1, inode: 1, size: payload.byteLength, mtimeMs: 0 },
    };
    await expect(__test__.validateManifestEntries(
      v3Manifest(entry),
      {
        entries: [],
        binaryJournalPath: journalPath,
      },
    )).rejects.toThrow(/SHA-256 mismatch/);
  });

  test("rejects staged payload length mismatch before hashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumiverse-archive-v3-length-"));
    roots.push(root);
    const payload = Buffer.from("payload");
    const payloadPath = join(root, "payload.bin");
    const journalPath = join(root, "binary.ndjson");
    await writeFile(payloadPath, payload);
    await writeFile(journalPath, `${JSON.stringify({
      kind: "binary",
      bucket: "audio",
      inner: "00000000-0000-0000-0000-000000000000.bin",
      stagingPath: payloadPath,
      byteSize: payload.byteLength,
    })}\n`);
    const entry = {
      path: "files/audio/00000000-0000-0000-0000-000000000000.bin",
      kind: "file" as const,
      required: false,
      bytes: payload.byteLength + 1,
      sha256: sha256(payload),
      sourceIdentity: { device: 1, inode: 1, size: payload.byteLength + 1, mtimeMs: 0 },
    };
    await expect(__test__.validateManifestEntries(
      v3Manifest(entry),
      {
        entries: [],
        binaryJournalPath: journalPath,
      },
    )).rejects.toThrow(/byte count mismatch/);
  });

  test("rejects duplicate database and binary payloads in the staged archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumiverse-archive-v3-duplicate-"));
    roots.push(root);
    const rowPath = join(root, "row.ndjson");
    const binaryPath = join(root, "payload.bin");
    const binaryJournalPath = join(root, "binary.ndjson");
    await writeFile(rowPath, "{}\n");
    await writeFile(binaryPath, "payload");
    await writeFile(binaryJournalPath, `${JSON.stringify({
      kind: "binary",
      bucket: "audio",
      inner: "00000000-0000-0000-0000-000000000000.bin",
      stagingPath: binaryPath,
      byteSize: 7,
    })}\n${JSON.stringify({
      kind: "binary",
      bucket: "audio",
      inner: "00000000-0000-0000-0000-000000000000.bin",
      stagingPath: binaryPath,
      byteSize: 7,
    })}\n`);
    const fileEntry = {
      path: "files/audio/00000000-0000-0000-0000-000000000000.bin",
      kind: "file" as const,
      required: false,
      bytes: 7,
      sha256: sha256(Buffer.from("payload")),
      sourceIdentity: { device: 1, inode: 1, size: 7, mtimeMs: 0 },
    };
    await expect(__test__.validateManifestEntries(
      v3Manifest(fileEntry),
      {
        entries: [
          { kind: "text", table: "duplicate", origin: "database", stagingPath: rowPath, byteSize: 3 },
          { kind: "text", table: "duplicate", origin: "database", stagingPath: rowPath, byteSize: 3 },
        ],
        binaryJournalPath,
      },
    )).rejects.toThrow(/duplicate archive payload entry/);

    await writeFile(binaryJournalPath, `${JSON.stringify({
      kind: "binary",
      bucket: "audio",
      inner: "00000000-0000-0000-0000-000000000000.bin",
      stagingPath: binaryPath,
      byteSize: 7,
    })}\n${JSON.stringify({
      kind: "binary",
      bucket: "audio",
      inner: "00000000-0000-0000-0000-000000000000.bin",
      stagingPath: binaryPath,
      byteSize: 7,
    })}\n`);
    await expect(__test__.validateManifestEntries(
      v3Manifest(fileEntry),
      {
        entries: [],
        binaryJournalPath,
      },
    )).rejects.toThrow(/duplicate archive payload entry/);
  });

  test("rejects unknown manifest entry kinds and unknown database tables", async () => {
    const valid = {
      producer: ARCHIVE_PRODUCER,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      exportedAt: 0,
      archiveId: "archive-v3",
      producerVersion: null,
      ndjsonFormatVersion: NDJSON_FORMAT_VERSION,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      embeddingIdentity: null,
      vectorStatus: "rebuild_required",
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: "snapshot-1",
      entries: [],
      fileAliases: [],
      counts: {},
      byteCounts: {},
      missingFiles: [],
      missingOptionalFiles: [],
    };
    expect(() => parseManifest({
      ...valid,
      includeVectors: true,
      embeddingConfig: { provider: "openai", model: "m", dimension: 2 },
      embeddingIdentity: { provider: "openai", model: "m", dimension: 2, revision: "0".repeat(64) },
      vectorStatus: "included",
      vectorSourceDigest: "1".repeat(64),
    })).toThrow(/vectorProjectionEpoch/);
    expect(parseManifest({
      ...valid,
      includeVectors: true,
      embeddingConfig: { provider: "openai", model: "m", dimension: 2 },
      embeddingIdentity: { provider: "openai", model: "m", dimension: 2, revision: "0".repeat(64) },
      vectorStatus: "included",
      vectorSourceDigest: "1".repeat(64),
      vectorProjectionEpoch: 4,
    }).vectorSourceDigest).toBe("1".repeat(64));
    expect(() => parseManifest({ ...valid, entries: [{ path: "database/chats.ndjson", kind: "unknown", required: true, bytes: 0, sha256: "0".repeat(64) }] }))
      .toThrow(/invalid archive entry kind/);
    expect(() => parseManifest({ ...valid, entries: [
      { path: "database/chats.ndjson", kind: "database", required: true, bytes: 0, sha256: "0".repeat(64) },
      { path: "database/chats.ndjson", kind: "database", required: true, bytes: 0, sha256: "0".repeat(64) },
    ] }))
      .toThrow(/duplicate archive entry/);

    const root = await mkdtemp(join(tmpdir(), "lumiverse-archive-unknown-table-"));
    roots.push(root);
    const rowPath = join(root, "row.ndjson");
    const journalPath = join(root, "binary.ndjson");
    await writeFile(rowPath, "{}\n");
    await writeFile(journalPath, "");
    const entry = {
      path: "database/not_a_canonical_table.ndjson",
      kind: "database" as const,
      required: true,
      bytes: 3,
      sha256: sha256(Buffer.from("{}\n")),
      rowCount: 1,
    };
    const manifest = v3Manifest(entry);
    manifest.counts = { not_a_canonical_table: 1 };
    manifest.byteCounts = { [entry.path]: entry.bytes };
    await expect(__test__.validateManifestEntries(
      manifest,
      {
        entries: [{ kind: "text", table: "not_a_canonical_table", origin: "database", stagingPath: rowPath, byteSize: 3 }],
        binaryJournalPath: journalPath,
      },
    )).rejects.toThrow(/not a canonical table/);
  });

  test("rejects unknown file buckets before treating a payload as a valid file", () => {
    expect(() => sanitizeEntry("files/not-a-bucket/asset.bin")).toThrow(/unknown prefix|bucket/);
  });
});

describe("registry graph and file omission contract", () => {
  test("binds owner, parent, nullable, and unique constraints in the registry", () => {
    const chats = getArchiveTableSpec("chats");
    const messages = getArchiveTableSpec("messages");
    const relations = getArchiveTableSpec("memory_relations");
    expect(chats?.owner).toMatchObject({ kind: "direct", column: "user_id" });
    const chatOwner = buildArchiveOwnerPredicate(chats!, "owner-1", "c");
    expect(chatOwner?.sql).toContain('"user_id" = ?');
    expect(chatOwner?.params).toEqual(["owner-1"]);

    expect(messages?.parentEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: "chat_id", parentTable: "chats", nullable: false, onMissing: "reject" }),
      expect.objectContaining({ column: "parent_message_id", parentTable: "messages", nullable: true, onMissing: "null_reference" }),
    ]));
    expect(relations?.uniqueKeys).toEqual(expect.arrayContaining([
      ["source_entity_id", "target_entity_id", "relation_type"],
    ]));
    const order = getCanonicalImportOrder();
    expect(order.indexOf("chats")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("messages")).toBeGreaterThan(order.indexOf("chats"));
  });

  test("declares every optional omission policy explicitly and required files fail closed", () => {
    const refs = ARCHIVE_TABLE_REGISTRY.flatMap((spec) => spec.fileRefs.map((ref) => ({ spec: spec.table, ref })));
    const optional = refs.filter(({ ref }) => !ref.required);
    expect(optional.length).toBeGreaterThan(0);
    expect(new Set(optional.map(({ ref }) => ref.onMissing))).toEqual(new Set(["null_reference", "preserve_absent"]));
    for (const { ref } of optional) expect(ref.onMissing).not.toBe("abort");
    for (const { ref } of refs.filter(({ ref }) => ref.required)) expect(ref.onMissing).toBe("abort");
  });
});

describe("archive media signatures", () => {
  test("rejects an active-content or extension-mismatched audio payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumiverse-archive-audio-"));
    roots.push(root);
    const path = join(root, "audio.bin");
    await writeFile(path, "<script>alert(1)</script>");
    expect(() => __test__.assertAudioPayload(path, "files/audio/00000000-0000-0000-0000-000000000000.mp3"))
      .toThrow(/audio content does not match extension/);
  });
});
