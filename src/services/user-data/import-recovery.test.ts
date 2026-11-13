import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { zipSync } from "fflate";
import { initDatabase, closeDatabase, getDb } from "../../db/connection";
import { env } from "../../env";
import { userDataRoutes } from "../../routes/user-data.routes";
import { getJob, resumeImport, reserveImportUpload, releaseImportUpload, importUploadSignal, cancelJob, persistUploadedArchive } from "./import.service";
import { saveImportJob } from "./import-job-store";

let directory: string;
let originalDataDir: string;
let child: ReturnType<typeof Bun.spawn> | undefined;
const userId = "recovery-owner";

beforeEach(async () => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lvbak-process-recovery-"));
  originalDataDir = env.dataDir;
  env.dataDir = directory;
  initDatabase(join(directory, "lumiverse.db"));
  getDb().run(await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text());
  getDb().query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
    .run(userId, "Recovery", "recovery@example.com");
});
afterEach(async () => {
  if (child) { child.kill("SIGKILL"); await child.exited; child = undefined; }
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

test("recovers a killed process, scopes discovery to its owner, and resumes without another upload", async () => {
  const jobId = crypto.randomUUID();
  const archiveDir = join(directory, "imports", userId, jobId);
  mkdirSync(archiveDir, { recursive: true });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
  writeFileSync(join(archiveDir, "archive.lvbak"), zipSync({
    "manifest.json": encode({ schemaVersion: 1, producer: "lumiverse", archiveId: crypto.randomUUID(), exportedAt: 0,
      includeVectors: false, embeddingConfig: { provider: null, model: null, dimension: null }, counts: {}, missingFiles: [] }),
    "database/characters.ndjson": encode({ id: "recovered-character", name: "Recovered", user_id: "source" }),
    "database/settings.ndjson": encode({ key: "recovered_setting", value: "true", user_id: "source" }),
    "files/databank/recovered.bin": new Uint8Array([4, 5, 6]),
  }));
  closeDatabase();
  child = Bun.spawn([process.execPath, join(import.meta.dir, "test-fixtures/import-process.ts"), directory, userId, jobId], { stdout: "ignore", stderr: "inherit" });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(directory, "committed")) && Date.now() < deadline) await Bun.sleep(5);
  expect(existsSync(join(directory, "committed"))).toBe(true);
  child.kill("SIGKILL"); await child.exited; child = undefined;
  initDatabase(join(directory, "lumiverse.db"));
  expect(getDb().query("SELECT COUNT(*) AS n FROM characters").get()).toEqual({ n: 1 });
  const recovered = getJob(jobId, userId)!;
  expect(recovered.status).toBe("interrupted");
  expect(recovered.progress).toMatchObject({ phase: "table_done", table: "characters" });
  recovered.archiveSecretKeys = ["do-not-persist"];
  saveImportJob(recovered);
  expect(readFileSync(join(archiveDir, "job.json"), "utf8")).not.toContain("do-not-persist");

  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", c.req.header("x-user") || userId); await next(); });
  app.route("/user-data", userDataRoutes);
  expect((await (await app.request("http://localhost/user-data/import")).json()).jobs).toEqual([{ jobId, status: "interrupted" }]);
  expect((await (await app.request("http://localhost/user-data/import", { headers: { "x-user": "other" } })).json()).jobs).toEqual([]);
  expect((await app.request(`http://localhost/user-data/import/${jobId}/resume`, { method: "POST", headers: { "x-user": "other" } })).status).toBe(404);
  const response = await app.request(`http://localhost/user-data/import/${jobId}/resume`, { method: "POST" });
  expect(response.status).toBe(202);
  const job = getJob(jobId)!;
  const resumedDeadline = Date.now() + 5000;
  while (job.status === "running" && Date.now() < resumedDeadline) await Bun.sleep(5);
  expect(job.error).toBeNull();
  expect(job.status).toBe("complete");
  expect(getDb().query("SELECT COUNT(*) AS n FROM characters").get()).toEqual({ n: 1 });
  expect(readFileSync(join(directory, "databank", userId, "recovered.bin"))).toEqual(Buffer.from([4, 5, 6]));
  expect(existsSync(join(archiveDir, "archive.lvbak"))).toBe(false);
  expect(() => resumeImport(userId, jobId)).toThrow("cannot be resumed");
});

test("native cancellation wakes a stalled upload and removes its partial file", async () => {
  const jobId = reserveImportUpload(userId)!;
  let waiting!: () => void;
  const reading = new Promise<void>(resolve => { waiting = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04])); },
    pull() { waiting(); return new Promise<void>(() => {}); },
    cancel() { return new Promise<void>(() => {}); },
  });
  try {
    const upload = persistUploadedArchive(userId, body, null, jobId, importUploadSignal(jobId));
    const rejected = upload.catch(error => error);
    await reading;
    expect(cancelJob(jobId)).toBe(true);
    expect(await rejected).toBeInstanceOf(Error);
    expect(existsSync(join(directory, "imports", userId, jobId, "archive.lvbak"))).toBe(false);
  } finally { releaseImportUpload(userId, jobId); }
});
