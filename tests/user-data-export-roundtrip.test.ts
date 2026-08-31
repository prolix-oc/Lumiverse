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
import { createHash } from "crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { join } from "path";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import {
  closeDatabase,
  getDb,
  initDatabase,
} from "../src/db/connection";
import { runMigrations } from "../src/db/migrate";
import { env } from "../src/env";
import { initIdentity } from "../src/crypto/init";
import { buildExportStream } from "../src/services/user-data/export.service";
import {
  __test__ as importTest,
  getJob,
  startImport,
  verifyArchiveFast,
  verifyArchive,
  type ImportJob,
} from "../src/services/user-data/import.service";
import { ARCHIVE_REGISTRY_VERSION } from "../src/services/user-data/table-registry";
import {
  ARCHIVE_SCHEMA_VERSION,
  NDJSON_FORMAT_VERSION,
  NDJSON_MAX_RECORD_BYTES,
  MAX_ARCHIVE_FILE_BYTES,
  parseManifest,
} from "../src/services/user-data/manifest";
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

function readArchiveNdjson(bytes: Uint8Array, archivePath: string): Record<string, any>[] {
  const entries = unzipSync(bytes);
  const encoded = entries[archivePath];
  if (!encoded) throw new Error(`archive is missing ${archivePath}`);
  return strFromU8(encoded)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function insertPreset(
  id: string,
  promptOrder: unknown[],
  metadata: Record<string, unknown> = {},
): void {
  getDb()
    .query(
      "INSERT INTO presets " +
        "(id, name, provider, parameters, prompt_order, metadata, prompts, user_id, engine, created_at, updated_at) " +
        "VALUES (?, ?, 'loom', '{}', ?, ?, '{}', ?, 'loom', 0, 0)",
    )
    .run(id, id, JSON.stringify(promptOrder), JSON.stringify(metadata), USER_ID);
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
const SOURCE_USER_ID = "export-roundtrip-source";

function insertPresetForUser(
  userId: string,
  id: string,
  promptOrder: unknown[],
  metadata: Record<string, unknown> = {},
): void {
  getDb()
    .query(
      "INSERT INTO presets " +
        "(id, name, provider, parameters, prompt_order, metadata, prompts, user_id, engine, created_at, updated_at) " +
        "VALUES (?, ?, 'loom', '{}', ?, ?, '{}', ?, 'loom', 0, 0)",
    )
    .run(id, id, JSON.stringify(promptOrder), JSON.stringify(metadata), userId);
}

async function waitForImportTerminal(jobId: string): Promise<ImportJob> {
  const job = getJob(jobId);
  if (!job) throw new Error(`import job ${jobId} was not found`);
  await job.completion;
  const terminal = getJob(jobId) ?? job;
  if (!["complete", "failed", "cancelled"].includes(terminal.status)) {
    throw new Error(`import job ${jobId} did not reach a terminal state`);
  }
  return terminal;
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
    await runMigrations(getDb());
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
    expect(manifest.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
    expect(manifest.ndjsonFormatVersion).toBe(NDJSON_FORMAT_VERSION);
    expect(manifest.ndjsonMaxRecordBytes).toBe(NDJSON_MAX_RECORD_BYTES);
    expect(manifest.archiveId).toMatch(/^[0-9a-f-]{36}$/i);
  });
  test("Quick Export recursively scrubs supported legacy image-generation API keys", async () => {
    const nanoSecret = "quick-export-nanogpt-secret";
    const novelSecret = "quick-export-novelai-secret";
    const nestedSecret = "quick-export-nested-secret";
    const deepSecret = "quick-export-deep-secret";
    const arraySecret = "quick-export-array-secret";
    const encodedSecret = "quick-export-encoded-secret";
    const imageGeneration = {
      enabled: true,
      unrelated: { apiKey: "retained-unrelated-api-key" },
      nanogpt: {
        apiKey: nanoSecret,
        model: "hidream",
        credentials: { apiKey: deepSecret, label: "primary" },
        variants: [{ nested: { apiKey: arraySecret, steps: 20 } }],
      },
      novelai: { apiKey: novelSecret, sampler: "k_euler" },
      compatibility: [
        { nanogpt: { apiKey: nestedSecret, model: "legacy-nested" } },
        { wrapper: { novelai: { apiKey: nestedSecret, steps: 28 } } },
      ],
      encodedCompatibility: JSON.stringify({
        wrapper: {
          nanogpt: {
            credentials: { apiKey: encodedSecret, label: "encoded" },
            model: "encoded-nano",
          },
        },
      }),
    };
    const insert = getDb().prepare(
      "INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 0)",
    );
    insert.run("imageGeneration", JSON.stringify(imageGeneration), USER_ID);
    insert.run("connection_legacy_api_key", "secret-setting-value", USER_ID);

    const bytes = await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }));
    const rows = readArchiveNdjson(bytes, "database/settings.ndjson");
    const exported = rows.find((row) => row.key === "imageGeneration");
    const archive = unzipSync(bytes);

    expect(exported).toBeDefined();
    expect(JSON.parse(exported!.value)).toEqual({
      enabled: true,
      unrelated: { apiKey: "retained-unrelated-api-key" },
      nanogpt: {
        model: "hidream",
        credentials: { label: "primary" },
        variants: [{ nested: { steps: 20 } }],
      },
      novelai: { sampler: "k_euler" },
      compatibility: [
        { nanogpt: { model: "legacy-nested" } },
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
    expect(rows.some((row) => row.key === "connection_legacy_api_key")).toBe(false);
    expect(Object.keys(archive).some((name) => name.startsWith("secrets/"))).toBe(false);
    const exportedManifest = JSON.parse(strFromU8(archive["manifest.json"]!));
    expect(exportedManifest.hasEncryptedSecrets).toBe(false);
    expect(exportedManifest.secretsCount).toBe(0);
    const archiveText = Object.values(archive).map((entry) => strFromU8(entry)).join("\n");
    for (const secret of [
      nanoSecret,
      novelSecret,
      nestedSecret,
      deepSecret,
      arraySecret,
      encodedSecret,
      "secret-setting-value",
    ]) {
      expect(archiveText).not.toContain(secret);
    }
    expect(archiveText).toContain("retained-unrelated-api-key");
  });

  test("Quick Export preserves an unrelated image-generation value exactly", async () => {
    const exactValue =
      ' { "__proto__": { "retained": "exact" }, "custom": { "apiKey": "unrelated" } } ';
    getDb()
      .prepare("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 0)")
      .run("imageGeneration", exactValue, USER_ID);

    const bytes = await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }));
    const exported = readArchiveNdjson(bytes, "database/settings.ndjson")
      .find((row) => row.key === "imageGeneration");
    const parsed = JSON.parse(exported!.value);

    expect(exported!.value).toBe(exactValue);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(parsed.__proto__).toEqual({ retained: "exact" });
    expect(parsed.custom).toEqual({ apiKey: "unrelated" });
  });

  test("Quick Export fails closed for Unicode-escaped malformed private data", async () => {
    const escapedPrivateData = String.raw`{"\u006e\u0061\u006e\u006f\u0067\u0070\u0074":{"\u0061\u0070\u0069\u004b\u0065\u0079":"escaped-export-secret"}`;
    getDb()
      .prepare("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 0)")
      .run(
        "imageGeneration",
        JSON.stringify({ wrapper: escapedPrivateData }),
        USER_ID,
      );

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(
      "imageGeneration settings contain malformed JSON-encoded provider data",
    );
  });
  test("redacts materialized sealed preset blocks into canonical portable descriptors", async () => {
    const secret = "ARCHIVE_SEALED_SECRET_distinctive_bytes_7b2f";
    const digest = createHash("sha256").update(secret, "utf8").digest("hex");
    const ordinaryBlock = {
      id: "ordinary-block",
      content: "ordinary prompt content",
      role: "system",
      enabled: true,
    };
    const sealedBlock = {
      id: "sealed-block",
      content: secret,
      role: "system",
      enabled: true,
      sealed: true,
      sealedKey: "dialogue.frame",
      sealedSource: "lumihub",
      sealedOriginPresetId: "hub-preset-7",
      sealedOriginVersion: "v3",
      sealedSha256: digest,
    };
    insertPreset("sealed-export", [ordinaryBlock, sealedBlock], {
      _lumiverse_lumihub_id: "hub-preset-7",
      _lumiverse_preset_version: "v3",
      _lumiverse_sealed_preset: {
        version: "v3",
        blocks: [{ key: "dialogue.frame", sha256: digest, materializedContent: secret }],
      },
    });

    const bytes = await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }));
    const rows = readArchiveNdjson(bytes, "database/presets.ndjson");
    const exported = rows.find((row) => row.id === "sealed-export");
    expect(exported).toBeDefined();
    const exportedBlocks = JSON.parse(exported!.prompt_order);
    const exportedMetadata = JSON.parse(exported!.metadata);
    expect(exportedBlocks[0]).toEqual(ordinaryBlock);
    expect(exportedBlocks[1]).toMatchObject({
      ...sealedBlock,
      content: "{{presetBlock::dialogue.frame}}",
      sealed: true,
      sealedKey: "dialogue.frame",
      sealedSource: "lumihub",
      sealedOriginPresetId: "hub-preset-7",
      sealedOriginVersion: "v3",
      sealedSha256: digest,
    });
    expect(exportedMetadata.portableSealedPreset).toEqual({
      hubPresetId: "hub-preset-7",
      hubPresetVersion: "v3",
      blocks: [{ key: "dialogue.frame", sha256: digest }],
    });
    expect(exportedMetadata._lumiverse_sealed_preset).toEqual({
      version: "v3",
      blocks: [{ key: "dialogue.frame", sha256: digest }],
    });

    const archiveText = Object.values(unzipSync(bytes))
      .map((entry) => strFromU8(entry))
      .join("\n");
    expect(archiveText).not.toContain(secret);
  });

  test("fails closed when a descriptor-listed materialized block loses its markers", async () => {
    const secretA = "ARCHIVE_SEALED_SECRET_A_distinctive_bytes";
    const secretB = "ARCHIVE_SEALED_SECRET_B_distinctive_bytes";
    const digestA = createHash("sha256").update(secretA, "utf8").digest("hex");
    const digestB = createHash("sha256").update(secretB, "utf8").digest("hex");
    insertPreset("partially-marked-sealed-export", [
      {
        id: "sealed-a",
        content: secretA,
        sealed: true,
        sealedKey: "dialogue.a",
        sealedSource: "lumihub",
        sealedOriginPresetId: "hub-preset-7",
        sealedOriginVersion: "v3",
        sealedSha256: digestA,
      },
      {
        id: "sealed-b",
        content: secretB,
      },
    ], {
      portableSealedPreset: {
        hubPresetId: "hub-preset-7",
        hubPresetVersion: "v3",
        blocks: [
          { key: "dialogue.a", sha256: digestA },
          { key: "dialogue.b", sha256: digestB },
        ],
      },
    });

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(/unredacted|descriptor/i);
  });

  test("preserves ordinary LumiHub presets with an explicit null sealed manifest", async () => {
    const ordinaryBlock = {
      id: "ordinary-lumihub-block",
      content: "ordinary LumiHub preset content",
      role: "system",
      enabled: true,
    };
    const metadata = {
      _lumiverse_lumihub_id: "hub-preset-ordinary",
      _lumiverse_preset_version: "v1",
      _lumiverse_sealed_preset: null,
    };
    insertPreset("ordinary-lumihub-export", [ordinaryBlock], metadata);

    const bytes = await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }));
    const rows = readArchiveNdjson(bytes, "database/presets.ndjson");
    const exported = rows.find((row) => row.id === "ordinary-lumihub-export");
    expect(exported).toBeDefined();
    expect(JSON.parse(exported!.prompt_order)).toEqual([ordinaryBlock]);
    expect(JSON.parse(exported!.metadata)).toEqual(metadata);
  });

  test("fails closed when sealed prompt_order data is not an array", async () => {
    getDb()
      .query(
        "INSERT INTO presets " +
          "(id, name, provider, parameters, prompt_order, metadata, prompts, user_id, engine, created_at, updated_at) " +
          "VALUES (?, ?, 'loom', '{}', ?, '{}', '{}', ?, 'loom', 0, 0)",
      )
      .run(
        "non-array-sealed-export",
        "non-array-sealed-export",
        JSON.stringify({ content: "ARCHIVE_NON_ARRAY_SEALED_SECRET", sealed: true }),
        USER_ID,
      );

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(/prompt_order must be an array/i);
  });

  test("retains a concrete legacy manifest version across equivalent candidates", async () => {
    const secret = "ARCHIVE_LEGACY_VERSION_SECRET";
    const digest = createHash("sha256").update(secret, "utf8").digest("hex");
    insertPreset("legacy-version-merge-export", [{
      id: "sealed-block",
      content: secret,
      sealed: true,
      sealedKey: "dialogue.versioned",
      sealedSource: "lumihub",
      sealedOriginPresetId: "hub-preset-versioned",
      sealedSha256: digest,
    }], {
      _lumiverse_lumihub_id: "hub-preset-versioned",
      _lumiverse_sealed_preset: {
        version: "v2",
        blocks: [{ key: "dialogue.versioned", sha256: digest }],
      },
      sealedPreset: {
        version: null,
        blocks: [{ key: "dialogue.versioned", sha256: digest }],
      },
    });

    const rows = readArchiveNdjson(await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    })), "database/presets.ndjson");
    const exported = rows.find((row) => row.id === "legacy-version-merge-export");
    expect(exported).toBeDefined();
    expect(JSON.parse(exported!.metadata)._lumiverse_preset_version).toBe("v2");
  });

  test("fails closed for invalid sealed block keys", async () => {
    const secret = "ARCHIVE_INVALID_SEALED_KEY_SECRET";
    const digest = createHash("sha256").update(secret, "utf8").digest("hex");
    insertPreset("invalid-sealed-key-export", [{
      id: "sealed-block",
      content: secret,
      sealed: true,
      sealedKey: "private}",
      sealedSource: "lumihub",
      sealedOriginPresetId: "hub-preset-invalid-key",
      sealedOriginVersion: "v1",
      sealedSha256: digest,
    }], {
      portableSealedPreset: {
        hubPresetId: "hub-preset-invalid-key",
        hubPresetVersion: "v1",
        blocks: [{ key: "private}", sha256: digest }],
      },
    });

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(/invalid block key/i);
  });
  test("fails closed for malformed sealed flag values", async () => {
    insertPreset("malformed-sealed-flag-export", [{
      id: "sealed-block",
      content: "ARCHIVE_MALFORMED_SEALED_FLAG_SECRET",
      sealed: null,
    }]);

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(/sealed preset block|manifest key/i);
  });

  test("fails closed for malformed LumiHub source markers", async () => {
    insertPreset("malformed-sealed-source-export", [{
      id: "sealed-block",
      content: "ARCHIVE_MALFORMED_SEALED_SOURCE_SECRET",
      sealedSource: "Lumihub",
    }]);

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(/sealed preset block|manifest key/i);
  });

  test("preserves ordinary LumiHub presets with an empty legacy sealed manifest", async () => {
    const ordinaryBlock = {
      id: "ordinary-empty-manifest-block",
      content: "ordinary LumiHub preset content",
      role: "system",
      enabled: true,
    };
    const metadata = {
      _lumiverse_lumihub_id: "hub-preset-empty",
      _lumiverse_preset_version: "v1",
      _lumiverse_sealed_preset: { version: "v1", blocks: [] },
    };
    insertPreset("ordinary-empty-manifest-export", [ordinaryBlock], metadata);

    const rows = readArchiveNdjson(await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    })), "database/presets.ndjson");
    const exported = rows.find((row) => row.id === "ordinary-empty-manifest-export");
    expect(exported).toBeDefined();
    expect(JSON.parse(exported!.prompt_order)).toEqual([ordinaryBlock]);
    expect(JSON.parse(exported!.metadata)).toEqual(metadata);
  });

  test("fails closed when sealed prompt block keys are duplicated", async () => {
    const secret = "ARCHIVE_DUPLICATE_SEALED_KEY_SECRET";
    const digest = createHash("sha256").update(secret, "utf8").digest("hex");
    const block = (id: string) => ({
      id,
      content: secret,
      sealed: true,
      sealedKey: "dialogue.duplicate",
      sealedSource: "lumihub",
      sealedOriginPresetId: "hub-preset-duplicate",
      sealedOriginVersion: "v1",
      sealedSha256: digest,
    });
    insertPreset("duplicate-sealed-key-export", [block("sealed-a"), block("sealed-b")], {
      portableSealedPreset: {
        hubPresetId: "hub-preset-duplicate",
        hubPresetVersion: "v1",
        blocks: [{ key: "dialogue.duplicate", sha256: digest }],
      },
    });

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(/duplicate prompt block key/i);
  });
  test("fails closed on malformed sealed metadata before archive completion", async () => {
    const secret = "ARCHIVE_MALFORMED_SEALED_SECRET_distinctive_bytes";
    insertPreset("malformed-sealed-export", [{
      id: "sealed-block",
      content: secret,
      sealed: true,
      sealedKey: "dialogue.frame",
      sealedSource: "lumihub",
    }], {
      portableSealedPreset: {
        hubPresetId: "hub-preset-7",
        hubPresetVersion: "v3",
        blocks: [{ key: "dialogue.frame", sha256: "not-a-digest" }],
      },
    });

    await expect(readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }))).rejects.toThrow(/SHA-256|digest/i);
  });
  test("V3 manifest is last and authenticates every emitted entry", async () => {
    const bytes = await readAll(
      buildExportStream({
        userId: USER_ID,
        includeVectors: false,
        producerVersion: "test",
      }),
    );
    const archive = unzipSync(bytes);
    const names = Object.keys(archive);
    expect(names[names.length - 1]).toBe("manifest.json");
    expect(new Set(names).size).toBe(names.length);
    const manifest = parseManifest(JSON.parse(strFromU8(archive["manifest.json"] ?? new Uint8Array())));
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.entries?.map((entry) => entry.path)).toEqual(
      manifest.entries?.map((entry) => entry.path).slice().sort((a, b) => a.localeCompare(b)),
    );
    for (const entry of manifest.entries ?? []) {
      const payload = archive[entry.path];
      if (!payload) throw new Error(`archive is missing ${entry.path}`);
      expect(payload.byteLength).toBe(entry.bytes);
      expect(createHash("sha256").update(payload).digest("hex")).toBe(entry.sha256);
      expect(manifest.byteCounts?.[entry.path]).toBe(entry.bytes);
    }
  });
  test("secret export fails closed when a selected key is missing", async () => {
    await expect(
      readAll(
        buildExportStream({
          userId: USER_ID,
          includeVectors: false,
          producerVersion: "test",
          secrets: {
            smk: new Uint8Array(32),
            secretKeys: ["missing-secret"],
            privateDataFingerprint: "unreached",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test("V3 parser rejects duplicate, traversal, and invalid SHA metadata", () => {
    const base = {
      schemaVersion: 3,
      producer: "lumiverse",
      exportedAt: 0,
      archiveId: crypto.randomUUID(),
      producerVersion: "test",
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      embeddingIdentity: "test-embedding",
      vectorStatus: "rebuild_required",
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: "snapshot-test",
      counts: {},
      missingFiles: [],
      missingOptionalFiles: [],
      fileAliases: [],
      byteCounts: { "database/settings.ndjson": 0 },
      entries: [
        {
          path: "database/settings.ndjson",
          kind: "database",
          required: true,
          bytes: 0,
          sha256: "0".repeat(64),
        },
      ],
    };
    expect(() => parseManifest({
      ...base,
      entries: undefined,
    })).toThrow(/entries/);
    expect(() => parseManifest({
      ...base,
      byteCounts: undefined,
    })).toThrow(/counts/);
    expect(() => parseManifest({
      ...base,
      byteCounts: { "database/settings.ndjson": Number.MAX_SAFE_INTEGER },
    })).toThrow(/exceeds/);
    const exactEntry = parseManifest({
      ...base,
      byteCounts: { "database/settings.ndjson": MAX_ARCHIVE_FILE_BYTES },
      entries: [{ ...base.entries[0], bytes: MAX_ARCHIVE_FILE_BYTES }],
    });
    expect(exactEntry.entries?.[0].bytes).toBe(MAX_ARCHIVE_FILE_BYTES);
    expect(() => parseManifest({
      ...base,
      byteCounts: { "database/settings.ndjson": MAX_ARCHIVE_FILE_BYTES + 1 },
      entries: [{ ...base.entries[0], bytes: MAX_ARCHIVE_FILE_BYTES + 1 }],
    })).toThrow(/exceeds/);
    expect(() => parseManifest({
      ...base,
      entries: [base.entries[0], { ...base.entries[0] }],
    })).toThrow(/duplicate archive entry/);
    expect(() => parseManifest({
      ...base,
      entries: [{ ...base.entries[0], sha256: "not-a-sha" }],
    })).toThrow(/SHA-256/);
    for (const path of ["../settings.ndjson", "database/../settings.ndjson", "./settings.ndjson", "database//settings.ndjson"]) {
      expect(() => parseManifest({
        ...base,
        entries: [{ ...base.entries[0], path }],
      })).toThrow(/invalid archive entry path/);
    }
  });
  test("V1/V2 manifests retain legacy defaults while V3 remains strict", () => {
    const legacy = parseManifest({
      schemaVersion: 1,
      producer: "lumiverse",
    });
    expect(legacy.archiveId).toBe("");
    expect(legacy.exportedAt).toBe(0);
    expect(legacy.producerVersion).toBeNull();
    expect(legacy.includeVectors).toBe(false);
    expect(legacy.embeddingConfig).toEqual({ provider: null, model: null, dimension: null });
    expect(legacy.counts).toEqual({});
    expect(legacy.missingFiles).toEqual([]);
    const legacyV2 = parseManifest({
      schemaVersion: 2,
      producer: "lumiverse",
    });
    expect(legacyV2).toMatchObject({
      archiveId: "",
      exportedAt: 0,
      producerVersion: null,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      counts: {},
      missingFiles: [],
    });

    expect(() => parseManifest({
      schemaVersion: 2,
      producer: "lumiverse",
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES + 1,
    })).toThrow(/advertises an NDJSON limit/);


    expect(() => parseManifest({
      schemaVersion: 3,
      producer: "lumiverse",
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      counts: {},
      missingFiles: [],
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: "snapshot",
      entries: [],
      fileAliases: [],
      byteCounts: {},
      missingOptionalFiles: [],
      vectorStatus: "rebuild_required",
      embeddingIdentity: "embedding",
    })).toThrow(/exportedAt|archiveId|producerVersion/);
  });

  test("V3 file entries require source identity bytes to match the payload", () => {
    const base = {
      schemaVersion: 3,
      producer: "lumiverse",
      exportedAt: 0,
      archiveId: crypto.randomUUID(),
      producerVersion: "test",
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      embeddingIdentity: "embedding",
      vectorStatus: "rebuild_required",
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: "snapshot",
      counts: {},
      missingFiles: [],
      missingOptionalFiles: [],
      fileAliases: [],
      byteCounts: { "files/images/a.bin": 2 },
    };
    const entry = {
      path: "files/images/a.bin",
      kind: "file",
      required: true,
      bytes: 2,
      sha256: "0".repeat(64),
    };
    expect(() => parseManifest({ ...base, entries: [entry] })).toThrow(/sourceIdentity.size/);
    expect(() => parseManifest({
      ...base,
      entries: [{ ...entry, sourceIdentity: { device: 1, inode: 2, size: 1, mtimeMs: 3 } }],
    })).toThrow(/sourceIdentity.size/);
    expect(parseManifest({
      ...base,
      entries: [{ ...entry, sourceIdentity: { device: 1, inode: 2, size: 2, mtimeMs: 3 } }],
    }).entries?.[0].sourceIdentity).toEqual({ device: 1, inode: 2, size: 2, mtimeMs: 3 });
  });


  test("V3 ledger preserves required and optional file references", () => {
    const manifest = parseManifest({
      schemaVersion: 3,
      producer: "lumiverse",
      exportedAt: 0,
      archiveId: crypto.randomUUID(),
      producerVersion: "test",
      ndjsonFormatVersion: 2,
      ndjsonMaxRecordBytes: NDJSON_MAX_RECORD_BYTES,
      includeVectors: false,
      embeddingConfig: { provider: null, model: null, dimension: null },
      embeddingIdentity: "test-embedding",
      vectorStatus: "rebuild_required",
      registryVersion: ARCHIVE_REGISTRY_VERSION,
      snapshotId: "snapshot-test",
      counts: {},
      missingFiles: ["optional-image"],
      missingOptionalFiles: ["files/images/optional.bin"],
      fileAliases: [],
      byteCounts: { "files/images/required.bin": 1 },
      entries: [
        {
          path: "files/images/required.bin",
          kind: "file",
          required: true,
          bytes: 1,
          sha256: "0".repeat(64),
          sourceIdentity: { device: 1, inode: 2, size: 1, mtimeMs: 3 },
        },
      ],
    });
    expect(manifest.entries?.[0].required).toBe(true);
    expect(manifest.missingOptionalFiles).toEqual(["files/images/optional.bin"]);
  });


  test("exports canonical agent tool-call limits and strips legacy metadata authority", async () => {
    const baseConfig = {
      version: 1,
      enabled: false,
      maxInvocations: 64,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
    };
    for (const [index, maxToolCalls] of [1, 64, Number.MAX_SAFE_INTEGER].entries()) {
      getDb().query(
        "INSERT INTO presets (id, name, provider, metadata, user_id) VALUES (?, ?, ?, ?, ?)",
      ).run(
        `agent-${index}`,
        `Agent ${index}`,
        "loom",
        JSON.stringify({ agentConfig: { ...baseConfig, maxToolCalls } }),
        USER_ID,
      );
      getDb().query(
        "INSERT INTO preset_agent_configs (user_id, preset_id, max_invocations, max_tool_calls) VALUES (?, ?, 64, ?)",
      ).run(USER_ID, `agent-${index}`, maxToolCalls);
    }
    getDb().query(
      "INSERT INTO presets (id, name, provider, metadata, user_id) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "agent-legacy",
      "Agent legacy",
      "loom",
      JSON.stringify({ agentConfig: baseConfig }),
      USER_ID,
    );
    getDb().query(
      "INSERT INTO presets (id, name, provider, metadata, user_id) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "agent-absent",
      "Agent absent",
      "loom",
      '{"extensionData":{"keep":true}}',
      USER_ID,
    );


    const bytes = await readAll(buildExportStream({
      userId: USER_ID,
      includeVectors: false,
      producerVersion: "test",
    }));
    const entries = unzipSync(bytes);
    const rows = strFromU8(entries["database/presets.ndjson"] ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; metadata: string });
    type ExportedMetadata = {
      agentConfig?: unknown;
      [key: string]: unknown;
    };
    const byId = new Map(rows.map((row) => [
      row.id,
      JSON.parse(row.metadata) as ExportedMetadata,
    ]));
    expect(byId.get("agent-0")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-1")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-2")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-legacy")?.agentConfig).toBeUndefined();
    expect(byId.get("agent-absent")).toEqual({ extensionData: { keep: true } });

    const configRows = strFromU8(entries["database/preset_agent_configs.ndjson"] ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { preset_id: string; max_tool_calls: number });
    const limitsByPreset = new Map(configRows.map((row) => [row.preset_id, row.max_tool_calls]));
    expect(limitsByPreset.get("agent-0")).toBe(1);
    expect(limitsByPreset.get("agent-1")).toBe(64);
    expect(limitsByPreset.get("agent-2")).toBe(Number.MAX_SAFE_INTEGER);
    expect(limitsByPreset.has("agent-legacy")).toBe(false);
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
    expect(manifest.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
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
  test("restores descriptor-only sealed presets before committing archive rows", async () => {
    const originalDataDir = env.dataDir;
    env.dataDir = workDir;
    let resolvedUserId: string | null = null;
    let resolvedDescriptor: unknown = null;
    try {
      await initIdentity();
      getDb()
        .query(
          "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) " +
            "VALUES (?, ?, ?, 1, ?, ?)",
        )
        .run(SOURCE_USER_ID, "Source User", "source@example.com", 0, 0);

      const secret = "ARCHIVE_RESTORE_SEALED_SECRET_distinctive_bytes";
      const digest = createHash("sha256").update(secret, "utf8").digest("hex");
      const ordinaryBlock = {
        id: "ordinary-restore-block",
        content: "ordinary restore content",
        role: "system",
        enabled: true,
      };
      const ordinaryMetadata = { ordinaryCarrier: "preserve-me", revision: 4 };
      insertPresetForUser(
        SOURCE_USER_ID,
        "ordinary-restore",
        [ordinaryBlock],
        ordinaryMetadata,
      );
      insertPresetForUser(
        SOURCE_USER_ID,
        "sealed-restore",
        [{
          id: "sealed-restore-block",
          content: secret,
          role: "system",
          enabled: true,
          sealed: true,
          sealedKey: "dialogue.frame",
          sealedSource: "lumihub",
          sealedOriginPresetId: "hub-preset-restore",
          sealedOriginVersion: "v3",
          sealedSha256: digest,
        }],
        {
          _lumiverse_lumihub_id: "hub-preset-restore",
          _lumiverse_preset_version: "v3",
          _lumiverse_sealed_preset: {
            version: "v3",
            blocks: [{ key: "dialogue.frame", sha256: digest, materializedContent: secret }],
          },
          compatibility: {
            lumiverse: {
              sealedPreset: {
                version: "v3",
                blocks: [{ key: "dialogue.frame", sha256: digest }],
              },
            },
          },
        },
      );


      importTest.setPortableSealedPresetResolverOverride(async (userId, descriptor) => {
        resolvedUserId = userId;
        resolvedDescriptor = descriptor;
        return { "dialogue.frame": secret };
      });
      const bytes = await readAll(buildExportStream({
        userId: SOURCE_USER_ID,
        includeVectors: false,
        producerVersion: "test",
      }));
      const archiveText = Object.values(unzipSync(bytes))
        .map((entry) => strFromU8(entry))
        .join("\n");
      expect(archiveText).not.toContain(secret);

      const archivePath = join(workDir, "sealed-restore.lvbak");
      writeFileSync(archivePath, bytes);
      const started = await startImport({
        userId: USER_ID,
        archivePath,
        jobId: crypto.randomUUID(),
      });
      const finished = await waitForImportTerminal(started.jobId);
      expect(finished.status).toBe("complete");

      const sealedRow = getDb()
        .query("SELECT prompt_order, metadata FROM presets WHERE user_id = ? AND id = ?")
        .get(USER_ID, "sealed-restore") as { prompt_order: string; metadata: string } | null;
      expect(sealedRow).not.toBeNull();
      const sealedBlocks = JSON.parse(sealedRow!.prompt_order) as Array<Record<string, unknown>>;
      const sealedMetadata = JSON.parse(sealedRow!.metadata) as Record<string, unknown>;
      expect(sealedBlocks[0]).toMatchObject({
        id: "sealed-restore-block",
        content: secret,
        sealed: true,
        sealedKey: "dialogue.frame",
        sealedSource: "lumihub",
        sealedOriginPresetId: "hub-preset-restore",
        sealedOriginVersion: "v3",
        sealedSha256: digest,
      });
      expect(sealedMetadata.portableSealedPreset).toEqual({
        hubPresetId: "hub-preset-restore",
        hubPresetVersion: "v3",
        blocks: [{ key: "dialogue.frame", sha256: digest }],
      });
      expect(sealedMetadata._lumiverse_sealed_preset).toEqual({
        version: "v3",
        blocks: [{ key: "dialogue.frame", sha256: digest }],
      });
      expect((sealedMetadata.compatibility as Record<string, any>).lumiverse.sealedPreset).toEqual({
        version: "v3",
        blocks: [{ key: "dialogue.frame", sha256: digest }],
      });
      expect(JSON.stringify(sealedMetadata)).not.toContain("materializedContent");

      const ordinaryRow = getDb()
        .query("SELECT prompt_order, metadata FROM presets WHERE user_id = ? AND id = ?")
        .get(USER_ID, "ordinary-restore") as { prompt_order: string; metadata: string } | null;
      expect(ordinaryRow).not.toBeNull();
      expect(JSON.parse(ordinaryRow!.prompt_order)).toEqual([ordinaryBlock]);
      expect(JSON.parse(ordinaryRow!.metadata)).toEqual(ordinaryMetadata);
      expect(resolvedUserId).toBe(USER_ID);
      expect(resolvedDescriptor).toEqual({
        hubPresetId: "hub-preset-restore",
        hubPresetVersion: "v3",
        blocks: [{ key: "dialogue.frame", sha256: digest }],
      });
    } finally {
      importTest.setPortableSealedPresetResolverOverride(null);
      env.dataDir = originalDataDir;
    }
  });

  test("rejects sealed archive failures without apply-phase mutations", async () => {
    const originalDataDir = env.dataDir;
    env.dataDir = workDir;
    let providerMode: "unresolved" | "digest" | "failure" = "unresolved";
    let resolverCalls = 0;
    let resolverUserId: string | null = null;
    let resolverDescriptor: unknown = null;
    try {
      await initIdentity();
      getDb()
        .query(
          "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) " +
            "VALUES (?, ?, ?, 1, ?, ?)",
        )
        .run(SOURCE_USER_ID, "Source User", "source@example.com", 0, 0);
      insertPreset(
        "restore-sentinel",
        [{ id: "sentinel", content: "must survive", role: "system", enabled: true }],
        { sentinel: "unchanged" },
      );

      const secret = "ARCHIVE_FAILURE_SEALED_SECRET_distinctive_bytes";
      const digest = createHash("sha256").update(secret, "utf8").digest("hex");
      insertPresetForUser(
        SOURCE_USER_ID,
        "sealed-failure",
        [{
          id: "sealed-failure-block",
          content: secret,
          role: "system",
          enabled: true,
          sealed: true,
          sealedKey: "dialogue.frame",
          sealedSource: "lumihub",
          sealedOriginPresetId: "hub-preset-failure",
          sealedOriginVersion: "v3",
          sealedSha256: digest,
        }],
        {
          _lumiverse_lumihub_id: "hub-preset-failure",
          _lumiverse_preset_version: "v3",
          _lumiverse_sealed_preset: {
            version: "v3",
            blocks: [{ key: "dialogue.frame", sha256: digest, materializedContent: secret }],
          },
          compatibility: {
            lumiverse: {
              sealedPreset: {
                version: "v3",
                blocks: [{ key: "dialogue.frame", sha256: digest }],
              },
            },
          },
        },
      );
      const sourceBytes = await readAll(buildExportStream({
        userId: SOURCE_USER_ID,
        includeVectors: false,
        producerVersion: "test",
      }));
      const sourceEntries = unzipSync(sourceBytes);
      const legacyManifestBytes = sourceEntries["manifest.json"];
      if (!legacyManifestBytes) throw new Error("source manifest is missing");
      const legacyManifest = JSON.parse(strFromU8(legacyManifestBytes)) as Record<string, unknown>;
      legacyManifest.schemaVersion = 1;
      delete legacyManifest.ndjsonFormatVersion;
      delete legacyManifest.ndjsonMaxRecordBytes;
      delete legacyManifest.entries;
      delete legacyManifest.vectorSourceDigest;
      delete legacyManifest.vectorProjectionEpoch;
      delete legacyManifest.registryVersion;
      delete legacyManifest.snapshotId;
      delete legacyManifest.fileAliases;
      delete legacyManifest.byteCounts;
      delete legacyManifest.missingOptionalFiles;
      delete legacyManifest.vectorStatus;
      delete legacyManifest.embeddingIdentity;
      sourceEntries["manifest.json"] = strToU8(JSON.stringify(legacyManifest));
      const sourceRows = readArchiveNdjson(sourceBytes, "database/presets.ndjson");

      const cases: Array<{
        name: string;
        mode: "unresolved" | "digest" | "failure";
        resolver: boolean;
        mutate: (row: Record<string, any>) => void;
      }> = [
        {
          name: "missing descriptor",
          mode: "unresolved",
          resolver: false,
          mutate: (row) => {
            row.metadata = JSON.stringify({
              _lumiverse_lumihub_id: "hub-preset-failure",
              _lumiverse_preset_version: "v3",
            });
          },
        },
        {
          name: "escaped sealed marker with wrong root shape",
          mode: "unresolved",
          resolver: false,
          mutate: (row) => {
            row.prompt_order = "{\"\\u0073ealed\":true,\"content\":\"\\u007b\\u007bpresetBlock::dialogue.frame\\u007d\\u007d\"}";
            row.metadata = "{}";
          },
        },
        {
          name: "empty sealed placeholder key",
          mode: "unresolved",
          resolver: false,
          mutate: (row) => {
            row.prompt_order = JSON.stringify([{
              id: "empty-placeholder",
              content: "{{presetBlock::   }}",
            }]);
            row.metadata = "{}";
          },
        },
        {
          name: "malformed descriptor",
          mode: "unresolved",
          resolver: false,
          mutate: (row) => {
            const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
            metadata.portableSealedPreset = {
              hubPresetId: "hub-preset-failure",
              hubPresetVersion: "v3",
              blocks: [],
            };
            row.metadata = JSON.stringify(metadata);
          },
        },
        {
          name: "marker-only extra sealed block",
          mode: "unresolved",
          resolver: false,
          mutate: (row) => {
            const blocks = JSON.parse(row.prompt_order) as unknown[];
            blocks.push({
              id: "extra-marker-only",
              content: "unresolved extra content",
              sealedSha256: digest,
            });
            row.prompt_order = JSON.stringify(blocks);
          },
        },
        {
          name: "contradictory legacy manifest",
          mode: "unresolved",
          resolver: false,
          mutate: (row) => {
            const metadata = JSON.parse(row.metadata) as Record<string, any>;
            metadata._lumiverse_sealed_preset.version = "v9";
            row.metadata = JSON.stringify(metadata);
          },
        },
        {
          name: "contradictory compatibility manifest",
          mode: "unresolved",
          resolver: false,
          mutate: (row) => {
            const metadata = JSON.parse(row.metadata) as Record<string, any>;
            metadata.compatibility.lumiverse.sealedPreset.version = "v8";
            row.metadata = JSON.stringify(metadata);
          },
        },
        {
          name: "unresolved block",
          mode: "unresolved",
          resolver: true,
          mutate: () => {},
        },
        {
          name: "digest mismatch",
          mode: "digest",
          resolver: true,
          mutate: () => {},
        },
        {
          name: "provider failure",
          mode: "failure",
          resolver: true,
          mutate: () => {},
        },
        {
          name: "link unavailable",
          mode: "unresolved",
          resolver: false,
          mutate: () => {},
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        providerMode = testCase.mode;
        const callsBefore = resolverCalls;
        if (testCase.resolver) {
          importTest.setPortableSealedPresetResolverOverride(async (userId, descriptor) => {
            resolverCalls++;
            resolverUserId = userId;
            resolverDescriptor = descriptor;
            if (providerMode === "failure") throw new Error("provider unavailable");
            if (providerMode === "unresolved") return {};
            return { "dialogue.frame": "wrong sealed content" };
          });
        } else {
          importTest.setPortableSealedPresetResolverOverride(null);
        }
        const entries = { ...sourceEntries };
        const rows = sourceRows.map((row) => ({ ...row }));
        const sealedRow = rows.find((row) => row.id === "sealed-failure");
        if (!sealedRow) throw new Error("sealed failure fixture row is missing");
        testCase.mutate(sealedRow);
        entries["database/presets.ndjson"] = strToU8(
          `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        );
        const archivePath = join(workDir, `sealed-failure-${index}.lvbak`);
        writeFileSync(archivePath, zipSync(entries));

        const started = await startImport({
          userId: USER_ID,
          archivePath,
          jobId: crypto.randomUUID(),
        });
        const finished = await waitForImportTerminal(started.jobId);
        expect(resolverCalls).toBe(callsBefore + (testCase.resolver ? 1 : 0));
        if (testCase.resolver) {
          expect(resolverUserId).toBe(USER_ID);
          expect(resolverDescriptor).toEqual({
            hubPresetId: "hub-preset-failure",
            hubPresetVersion: "v3",
            blocks: [{ key: "dialogue.frame", sha256: digest }],
          });
        }
        expect(finished.status).toBe("failed");
        const sentinel = getDb()
          .query("SELECT prompt_order, metadata FROM presets WHERE user_id = ? AND id = ?")
          .get(USER_ID, "restore-sentinel") as { prompt_order: string; metadata: string } | null;
        expect(sentinel).toEqual({
          prompt_order: JSON.stringify([{
            id: "sentinel",
            content: "must survive",
            role: "system",
            enabled: true,
          }]),
          metadata: JSON.stringify({ sentinel: "unchanged" }),
        });
        const count = getDb()
          .query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?")
          .get(USER_ID) as { count: number };
        expect(count.count).toBe(1);
      }
    } finally {
      importTest.setPortableSealedPresetResolverOverride(null);
      env.dataDir = originalDataDir;
    }
  });
});
