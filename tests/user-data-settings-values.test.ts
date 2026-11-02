import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { env } from "../src/env";
import { putSetting } from "../src/services/settings.service";
import { MAX_SETTING_VALUE_FILE_BYTES } from "../src/services/user-data/archive-limits";
import { buildExportStream } from "../src/services/user-data/export.service";
import { startImport, verifyArchiveFast, type ImportJob } from "../src/services/user-data/import.service";
import { createManifest, NDJSON_MAX_RECORD_BYTES, parseManifest } from "../src/services/user-data/manifest";

const SOURCE = "settings-source";
const TARGET = "settings-target";
const VALUE_FILE = "settings-values/123e4567-e89b-12d3-a456-426614174000.json";
const originalDataDir = env.dataDir;
let directory: string;

beforeEach(async () => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lvbak-settings-"));
  env.dataDir = directory;
  const db = initDatabase(":memory:");
  db.run(await Bun.file(join(import.meta.dir, "../src/db/baseline.sql")).text());
  for (const id of [SOURCE, TARGET]) {
    db.query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
      .run(id, id, `${id}@example.invalid`);
  }
});

afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

function manifest(schemaVersion = 3) {
  return { ...createManifest({
    archiveId: crypto.randomUUID(), includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    producerVersion: "test", counts: {}, missingFiles: [],
  }), schemaVersion };
}

async function finish(job: ImportJob) {
  const deadline = Date.now() + 30_000;
  while (!["complete", "failed", "cancelled"].includes(job.status) && Date.now() < deadline) await Bun.sleep(5);
  return job;
}

function valueFor(userId: string, key = "savedThemes"): string | undefined {
  return (getDb().query("SELECT value FROM settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | null)?.value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(
  row: Record<string, unknown>,
  entries: Record<string, Uint8Array> = {},
  schemaVersion = 3,
): Uint8Array {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest(schemaVersion))),
    "database/settings.ndjson": strToU8(JSON.stringify({ key: "savedThemes", user_id: SOURCE, ...row }) + "\n"),
    ...entries,
  });
}

async function restore(bytes: Uint8Array) {
  const archivePath = join(directory, "input.lvbak");
  writeFileSync(archivePath, bytes);
  return finish(startImport({ userId: TARGET, archivePath, jobId: crypto.randomUUID() }));
}

describe("large settings backup values", () => {
  test("exports and restores a saved theme with 128 MiB of base64 assets byte for byte", async () => {
    const expected = (() => {
      const dataBase64 = "A".repeat(64 * 1024 * 1024); // Two supported 48 MiB binary assets.
      const value = [{ kind: "pack", id: "large-theme", name: "Large theme", createdAt: 0, pack: {
        format: 2, name: "Large theme", author: "", description: "", createdAt: 0, bundleId: "large-theme",
        theme: null, globalCSS: "", components: {}, assets: [1, 2].map(id => ({
          slug: `asset-${id}.bin`, originalFilename: `asset-${id}.bin`, mimeType: "application/octet-stream",
          tags: [], metadata: {}, dataBase64,
        })),
      } }];
      putSetting(SOURCE, "savedThemes", value);
      const json = valueFor(SOURCE)!;
      expect(Buffer.byteLength(json)).toBeGreaterThan(NDJSON_MAX_RECORD_BYTES);
      return hash(json);
    })();
    putSetting(SOURCE, "smallSetting", { enabled: true });
    const firstDir = join(directory, "first");
    const secondDir = join(directory, "second");
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    const archivePath = join(firstDir, "export.lvbak");
    const secondPath = join(secondDir, "export.lvbak");
    await Bun.write(archivePath, new Response(buildExportStream({ userId: SOURCE, includeVectors: false })));
    expect((await verifyArchiveFast(archivePath)).schemaVersion).toBe(3);
    // Reading embedding configuration during export can persist defaults.
    const settingCount = (getDb().query("SELECT COUNT(*) AS n FROM settings WHERE user_id = ?").get(SOURCE) as { n: number }).n;
    copyFileSync(archivePath, secondPath);

    const job = await finish(startImport({ userId: TARGET, archivePath, jobId: crypto.randomUUID() }));
    expect(job.error).toBeNull();
    expect(job.status).toBe("complete");
    expect(hash(valueFor(TARGET)!)).toBe(expected);
    expect(valueFor(TARGET, "smallSetting")).toBe('{"enabled":true}');
    expect(job.summary.settings).toEqual({ imported: settingCount, skipped: 0 });

    const repeated = await finish(startImport({ userId: TARGET, archivePath: secondPath, jobId: crypto.randomUUID() }));
    expect(repeated.error).toBeNull();
    expect(repeated.status).toBe("complete");
    expect(repeated.summary.settings).toEqual({ imported: 0, skipped: settingCount });
    expect(hash(valueFor(TARGET)!)).toBe(expected);
  }, 60_000);

  test("preserves escapes and a surrogate pair split at a streaming chunk boundary", async () => {
    const value = "x".repeat(65534) + "🌙" + '\n"\\\u0000'.repeat(1024 * 1024);
    putSetting(SOURCE, "savedThemes", value);
    const expected = hash(valueFor(SOURCE)!);
    const bytes = new Uint8Array(await new Response(buildExportStream({ userId: SOURCE, includeVectors: false })).arrayBuffer());
    const entries = unzipSync(bytes);
    const rows = new TextDecoder().decode(entries["database/settings.ndjson"]).trim().split("\n").map(line => JSON.parse(line));
    const row = rows.find(row => row.key === "savedThemes");
    expect(row.value).toBeNull();
    expect(row.valueFile).toMatch(/^settings-values\/.+\.json$/);
    expect(hash(new TextDecoder().decode(entries[row.valueFile]))).toBe(expected);
    const job = await restore(bytes);
    expect(job.error).toBeNull();
    expect(job.status).toBe("complete");
    expect(hash(valueFor(TARGET)!)).toBe(expected);
  });

  test("preserves the normal settings merge policy for external values", async () => {
    putSetting(TARGET, "imageGeneration", { enabled: false, promptPresets: [{ id: "existing" }] });
    const job = await restore(fixture({ key: "imageGeneration", value: null, valueFile: VALUE_FILE }, {
      [VALUE_FILE]: strToU8(JSON.stringify({ enabled: true, promptPresets: [{ id: "imported" }], extra: 42 })),
    }));
    expect(job.error).toBeNull();
    expect(job.status).toBe("complete");
    expect(JSON.parse(valueFor(TARGET, "imageGeneration")!)).toEqual({
      enabled: false, promptPresets: [{ id: "existing" }, { id: "imported" }], extra: 42,
    });
  });

  test("filters secret settings before creating external payloads", async () => {
    putSetting(SOURCE, "savedThemes", "x".repeat(9 * 1024 * 1024));
    getDb().query(`INSERT INTO settings (key, value, user_id, updated_at)
      SELECT 'connection_legacy_api_key', value, user_id, updated_at FROM settings WHERE key = 'savedThemes' AND user_id = ?`)
      .run(SOURCE);
    const bytes = new Uint8Array(await new Response(buildExportStream({ userId: SOURCE, includeVectors: false })).arrayBuffer());
    const entries = unzipSync(bytes);
    expect(Object.keys(entries).filter(name => name.startsWith("settings-values/"))).toHaveLength(1);
    expect(new TextDecoder().decode(entries["database/settings.ndjson"])).not.toContain("connection_legacy_api_key");
  });

  test("aborts while streaming an external settings payload", async () => {
    putSetting(SOURCE, "savedThemes", "x".repeat(9 * 1024 * 1024));
    const abort = new AbortController();
    const reader = buildExportStream({ userId: SOURCE, includeVectors: false, signal: abort.signal }).getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort(new Error("cancelled settings export"));
    try {
      await expect((async () => {
        while (!(await reader.read()).done) { /* drain until cancellation */ }
      })()).rejects.toThrow("cancelled settings export");
    } finally {
      reader.releaseLock();
    }
  });

  test.each([
    ["missing payload", { value: null, valueFile: VALUE_FILE }, {}, 3, "Missing external value"],
    ["traversal", { value: null, valueFile: "settings-values/../outside.json" }, {}, 3, "traversal"],
    ["wrong entry kind", { value: null, valueFile: "manifest.json" }, {}, 3, "Invalid external value path"],
    ["non-string reference", { value: null, valueFile: 42 }, {}, 3, "Invalid external value reference"],
    ["ambiguous value", { value: "[]", valueFile: VALUE_FILE }, { [VALUE_FILE]: strToU8("[]") }, 3, "Invalid external value reference"],
    ["old schema reference", { value: null, valueFile: VALUE_FILE }, {}, 2, "Invalid external value reference"],
    ["old schema payload", { value: null, valueFile: VALUE_FILE }, { [VALUE_FILE]: strToU8("[]") }, 2, "requires archive schema 3"],
    ["duplicate payload", { value: null, valueFile: VALUE_FILE }, {
      [VALUE_FILE]: strToU8("[]"), [VALUE_FILE.replace("/", "\\")]: strToU8("[1]"),
    }, 3, "duplicate settings value entry"],
  ] as const)("rejects %s without replacing the target setting", async (_name, row, entries, schemaVersion, message) => {
    putSetting(TARGET, "savedThemes", ["retained"]);
    const job = await restore(fixture(row, entries, schemaVersion));
    expect(job.status).toBe("failed");
    expect(job.error).toContain(message);
    expect(valueFor(TARGET)).toBe('["retained"]');
  });

  test("rejects an external value above its byte cap before inflation", async () => {
    const bytes = fixture({ value: null, valueFile: VALUE_FILE }, { [VALUE_FILE]: strToU8("[]") });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(offset + 28, true);
      if (decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)) === VALUE_FILE) {
        view.setUint32(offset + 24, MAX_SETTING_VALUE_FILE_BYTES + 1, true);
        break;
      }
    }
    const job = await restore(bytes);
    expect(job.status).toBe("failed");
    expect(job.error).toContain(`exceeds ${MAX_SETTING_VALUE_FILE_BYTES} bytes`);
    expect(valueFor(TARGET)).toBeUndefined();
  });

  test("still reads schema 1 and 2 inline settings", async () => {
    for (const schemaVersion of [1, 2]) {
      const job = await restore(fixture({ key: `legacy${schemaVersion}`, value: "true" }, {}, schemaVersion));
      expect(job.error).toBeNull();
      expect(job.status).toBe("complete");
      expect(valueFor(TARGET, `legacy${schemaVersion}`)).toBe("true");
    }
    expect(() => parseManifest(manifest(4))).toThrow("newer than this server supports");
  });
});
