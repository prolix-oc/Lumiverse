import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { strToU8, unzipSync, zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { stopDatabaseExecution } from "../src/db/execution";
import { getUserExtensionPath } from "../src/auth/provision";
import { initIdentity } from "../src/crypto/init";
import { env } from "../src/env";
import { userDataRoutes } from "../src/routes/user-data.routes";
import { WorkerHostStorageApi } from "../src/spindle/worker-host-storage-api";
import { getSetting, putSetting } from "../src/services/settings.service";
import { getSecret, putSecret, SYSTEM_SECRET_PRINCIPAL } from "../src/services/secrets.service";
import { buildExportStream } from "../src/services/user-data/export.service";
import { startImport, submitTicket, skipTicket, type ImportJob } from "../src/services/user-data/import.service";
import { ARCHIVE_SCHEMA_VERSION, createManifest } from "../src/services/user-data/manifest";

const SOURCE = "extension-source";
const TARGET = "extension-target";
const OTHER = "extension-other";
const TOKEN = "synthetic-enclave-refresh-token";
const SECRET_KEY = "spindle:private_addon:refresh_token";
const SETTING_KEY = "spindle:private_addon:preferences:config";
const originalDataDir = env.dataDir;
let directory: string;
let app: Hono;

function host(identifier: string, userId: string, operator = false) {
  const responses = new Map<string, { result?: unknown; error?: string }>();
  const api = new WorkerHostStorageApi({ identifier, installScope: operator ? "operator" : "user",
    installedByUserId: operator ? null : userId, hasPermission: () => true,
    postResponse: message => { responses.set(message.requestId, message); },
  });
  return { api, responses };
}

function write(path: string, value: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

beforeEach(async () => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lvbak-extensions-"));
  env.dataDir = directory;
  const db = initDatabase(":memory:");
  db.run(await Bun.file(join(import.meta.dir, "../src/db/baseline.sql")).text());
  for (const id of [SOURCE, TARGET, OTHER]) {
    db.query('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(id, id, `${id}@example.invalid`);
  }
  await initIdentity();
  const own = host("private_addon", SOURCE);
  own.api.handleStorageWrite("config", "config.json", '{"private":true}');
  own.api.handleStorageWriteBinary("binary", "nested/data.bin", new Uint8Array([0, 255, 128, 42]));
  own.api.handleStorageWrite("unicode", "notes/日本語 notes.txt", "日本語 🌙");
  own.api.handleStorageWrite("hidden", ".hidden", "retained");
  for (const response of own.responses.values()) expect(response.error).toBeUndefined();
  const shared = host("shared_addon", SOURCE, true);
  shared.api.handleUserStorageWrite("config", "config.json", '{"perUser":true}', SOURCE);
  expect(shared.responses.get("config")?.error).toBeUndefined();
  write(join(getUserExtensionPath(SOURCE, "private_addon"), ".ephemeral/cache.bin"), "temporary");
  write(join(getUserExtensionPath(SOURCE, "private_addon"), ".ephemeral/.index.json"), "{}");
  write(join(getUserExtensionPath(OTHER, "private_addon"), "other.json"), "other user");
  write(join(directory, "extensions/shared_addon/storage/global.json"), "operator only");
  putSetting(SOURCE, SETTING_KEY, { color: "purple" });
  app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", SOURCE); await next(); });
  app.route("/user-data", userDataRoutes);
});

afterEach(async () => {
  await stopDatabaseExecution();
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

async function wait(job: ImportJob, state: ImportJob["status"]) {
  const deadline = Date.now() + 10_000;
  while (job.status !== state && !["complete", "failed", "cancelled"].includes(job.status) && Date.now() < deadline) await Bun.sleep(5);
  expect(job.error).toBeNull();
  expect(job.status).toBe(state);
}

async function importBytes(bytes: Uint8Array) {
  const archivePath = join(directory, crypto.randomUUID(), "archive.lvbak");
  write(archivePath, bytes);
  return startImport({ userId: TARGET, archivePath, jobId: crypto.randomUUID() });
}

function fileFixture(inner: string, schemaVersion = ARCHIVE_SCHEMA_VERSION, included = true) {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ ...createManifest({
      archiveId: crypto.randomUUID(), includeVectors: false, includeExtensionData: included,
      embeddingConfig: { provider: null, model: null, dimension: null }, producerVersion: "test", counts: {}, missingFiles: [],
    }), schemaVersion })),
    [`files/extension-storage/${inner}`]: strToU8("restored"),
  });
}

describe("optional extension files", () => {
  test("service callers omit files by default while keeping extension preferences", async () => {
    const bytes = new Uint8Array(await new Response(buildExportStream({ userId: SOURCE, includeVectors: false })).arrayBuffer());
    const entries = unzipSync(bytes);
    expect(Object.keys(entries).some(name => name.startsWith("files/extension-storage/"))).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(entries["manifest.json"])).includeExtensionData).toBe(false);
    const job = await importBytes(bytes);
    await wait(job, "complete");
    expect(getSetting(TARGET, SETTING_KEY)?.value).toEqual({ color: "purple" });
    expect(existsSync(join(getUserExtensionPath(TARGET, "private_addon"), "config.json"))).toBe(false);
  });

  test.each([undefined, "0", "1"])("GET option %s controls extension files", async option => {
    const response = await app.request(`/user-data/export?includeVectors=0${option === undefined ? "" : `&includeExtensionData=${option}`}`);
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(entries).some(name => name.startsWith("files/extension-storage/"))).toBe(option === "1");
    expect(JSON.parse(new TextDecoder().decode(entries["manifest.json"])).includeExtensionData).toBe(option === "1");
  });

  test.each([undefined, "true", true])("prepared export requires explicit boolean opt-in %s", async option => {
    const prepared = await (await app.request("/user-data/export/prepare", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeExtensionData: option }),
    })).json() as any;
    const response = await app.request(`/user-data/export/archive/${prepared.archiveId}`);
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(entries).some(name => name.startsWith("files/extension-storage/"))).toBe(option === true);
  });

  test.each([[false, false], [true, false], [false, true], [true, true]])(
    "prepared export files=%s secrets=%s restores only selected data", async (includeExtensionData, includeSecrets) => {
      const own = host("private_addon", SOURCE);
      await own.api.handleEnclavePut("put", "refresh_token", TOKEN);
      expect(own.responses.get("put")?.error).toBeUndefined();
      await putSecret(OTHER, SECRET_KEY, "other-account-token");
      await putSecret(SYSTEM_SECRET_PRINCIPAL, SECRET_KEY, "system-token");
      const prepared = await (await app.request("/user-data/export/prepare", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ includeVectors: false, includeExtensionData, includeSecrets }),
      })).json() as any;
      const response = await app.request(`/user-data/export/archive/${prepared.archiveId}`);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const entries = unzipSync(bytes);
      const paths = Object.keys(entries).filter(name => name.startsWith("files/extension-storage/"));
      expect(paths.sort()).toEqual(includeExtensionData ? [
        "files/extension-storage/private_addon/.hidden", "files/extension-storage/private_addon/config.json",
        "files/extension-storage/private_addon/nested/data.bin", "files/extension-storage/private_addon/notes/日本語 notes.txt",
        "files/extension-storage/shared_addon/config.json",
      ].sort() : []);
      expect(Object.keys(entries).some(name => name.includes(".ephemeral") || name.includes("global.json") || name.includes("other.json"))).toBe(false);
      for (const data of Object.values(entries)) expect(new TextDecoder().decode(data)).not.toContain(TOKEN);
      expect(Boolean(entries["secrets/encrypted.ndjson"])).toBe(includeSecrets);
      if (includeSecrets) expect(JSON.parse(new TextDecoder().decode(entries["secrets/index.json"])).keys).toEqual([SECRET_KEY]);
      const job = await importBytes(bytes);
      if (includeSecrets) {
        await wait(job, "awaiting_ticket");
        await submitTicket(job.jobId, prepared.ticket);
      }
      await wait(job, "complete");
      expect(getSetting(TARGET, SETTING_KEY)?.value).toEqual({ color: "purple" });
      const target = host("private_addon", TARGET);
      target.api.handleStorageExists("exists", "config.json");
      expect(target.responses.get("exists")?.result).toBe(includeExtensionData);
      if (includeExtensionData) {
        target.api.handleStorageRead("read", "config.json");
        expect(target.responses.get("read")?.result).toBe('{"private":true}');
        expect([...readFileSync(join(getUserExtensionPath(TARGET, "private_addon"), "nested/data.bin"))]).toEqual([0, 255, 128, 42]);
        expect(readFileSync(join(getUserExtensionPath(TARGET, "shared_addon"), "config.json"), "utf8")).toBe('{"perUser":true}');
        expect(job.fileSummary["extension-storage"]).toBe(5);
      }
      await target.api.handleEnclaveGet("get", "refresh_token");
      expect(target.responses.get("get")?.result).toBe(includeSecrets ? TOKEN : null);
      expect(await getSecret(OTHER, SECRET_KEY)).toBe("other-account-token");
      expect(await getSecret(SYSTEM_SECRET_PRINCIPAL, SECRET_KEY)).toBe("system-token");
    },
  );

  test("preserves destination files and safely repeats the same restore", async () => {
    write(join(getUserExtensionPath(TARGET, "private_addon"), "config.json"), "existing");
    const bytes = new Uint8Array(await new Response(buildExportStream({ userId: SOURCE, includeVectors: false, includeExtensionData: true })).arrayBuffer());
    const first = await importBytes(bytes);
    await wait(first, "complete");
    const second = await importBytes(bytes);
    await wait(second, "complete");
    expect(readFileSync(join(getUserExtensionPath(TARGET, "private_addon"), "config.json"), "utf8")).toBe("existing");
    expect(first.fileSummary["extension-storage"]).toBe(4);
    expect(second.fileSummary["extension-storage"]).toBeUndefined();
    expect(readFileSync(join(getUserExtensionPath(SOURCE, "private_addon"), "config.json"), "utf8")).toBe('{"private":true}');
  });

  test("skipping a secret ticket still restores selected extension files", async () => {
    await putSecret(SOURCE, SECRET_KEY, TOKEN);
    const prepared = await (await app.request("/user-data/export/prepare", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeExtensionData: true, includeSecrets: true }),
    })).json() as any;
    const response = await app.request(`/user-data/export/archive/${prepared.archiveId}`);
    const job = await importBytes(new Uint8Array(await response.arrayBuffer()));
    await wait(job, "awaiting_ticket");
    expect(skipTicket(job.jobId)).toBe(true);
    await wait(job, "complete");
    expect(job.fileSummary["extension-storage"]).toBe(5);
    expect(await getSecret(TARGET, SECRET_KEY)).toBeNull();
  });

  test("does not follow exported symlinks and reports skipped files", async () => {
    const outside = join(directory, "outside");
    write(join(outside, "sensitive.txt"), "not-exportable");
    const root = getUserExtensionPath(SOURCE, "private_addon");
    symlinkSync(join(outside, "sensitive.txt"), join(root, "link.txt"));
    symlinkSync(outside, join(root, "linked-directory"));
    const bytes = new Uint8Array(await new Response(buildExportStream({ userId: SOURCE, includeVectors: false, includeExtensionData: true })).arrayBuffer());
    const entries = unzipSync(bytes);
    expect(Object.keys(entries).some(name => /link.txt|linked-directory|sensitive.txt/.test(name))).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(entries["manifest-stats.json"])).missingFiles.sort()).toEqual([
      join(root, "link.txt"), join(root, "linked-directory"),
    ].sort());
  });

  test.each(["directory", "file", "temporary"])("rejects a destination %s symlink", async kind => {
    const outside = join(directory, "outside");
    write(join(outside, "config.json"), "unchanged");
    const root = getUserExtensionPath(TARGET, "private_addon");
    mkdirSync(root, { recursive: true });
    if (kind === "directory") symlinkSync(outside, join(root, "nested"));
    if (kind === "file") symlinkSync(join(outside, "config.json"), join(root, "config.json"));
    const jobId = crypto.randomUUID();
    if (kind === "temporary") symlinkSync(join(outside, "config.json"), join(root, `.lv-restore-${jobId}.tmp`));
    const archivePath = join(directory, crypto.randomUUID(), "archive.lvbak");
    write(archivePath, fileFixture(kind === "directory" ? "private_addon/nested/config.json" : "private_addon/config.json"));
    const job = startImport({ userId: TARGET, archivePath, jobId });
    const deadline = Date.now() + 5000;
    while (!["failed", "complete"].includes(job.status) && Date.now() < deadline) await Bun.sleep(5);
    expect(job.status).toBe("failed");
    expect(readFileSync(join(outside, "config.json"), "utf8")).toBe("unchanged");
  });

  test.each([
    ["private_addon/../outside.json", 4, true], ["private_addon/.ephemeral/cache", 4, true],
    ["private_addon/config.json", 3, true], ["private_addon/config.json", 4, false],
  ] as const)("rejects invalid or undeclared extension entry %s schema %s included %s", async (inner, schema, included) => {
    const job = await importBytes(fileFixture(inner, schema, included));
    const deadline = Date.now() + 5000;
    while (!["failed", "complete"].includes(job.status) && Date.now() < deadline) await Bun.sleep(5);
    expect(job.status).toBe("failed");
    expect(existsSync(getUserExtensionPath(TARGET, "private_addon"))).toBe(false);
  });
});
