import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { resetStBackupUploadState } from "../migration/st-backup-upload";

// Sessions are supplied by createApp; retain the real role gate without
// starting Better Auth against this suite's deliberately minimal schema.
mock.module("../auth/index", () => ({ auth: { api: {} } }));
const { stMigrationRoutes } = await import("./st-migration.routes");

function createApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const role = c.req.header("x-test-role");
    if (role) {
      const userId = c.req.header("x-test-user") ?? "caller";
      c.set("userId", userId);
      c.set("session", { user: { id: userId, role }, session: {} } as never);
    }
    await next();
  });
  app.route("/st-migration", stMigrationRoutes);
  return app;
}

const app = createApp();
const executeUrl = "http://localhost/st-migration/execute";
const objectBodyUrls = [
  "http://localhost/st-migration/test-connection",
  "http://localhost/st-migration/validate",
  "http://localhost/st-migration/scan",
  executeUrl,
];
const ownerHeaders = { "content-type": "application/json", "x-test-role": "owner", "x-test-user": "owner-a" };
let workDir = "";
let originalDataDir = "";

beforeEach(() => {
  originalDataDir = env.dataDir;
  workDir = mkdtempSync(join(tmpdir(), "st-migration-route-"));
  env.dataDir = workDir;
  resetStBackupUploadState();
  closeDatabase();
  initDatabase(":memory:");
  getDb().run('CREATE TABLE "user" (id TEXT PRIMARY KEY, role TEXT NOT NULL)');
  getDb().run('INSERT INTO "user" (id, role) VALUES (?, ?), (?, ?)', ["owner-a", "owner", "user-a", "user"]);
});
afterEach(() => {
  resetStBackupUploadState();
  closeDatabase();
  env.dataDir = originalDataDir;
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe("SillyTavern migration route security", () => {
  test("requires an authenticated owner or admin", async () => {
    const anonymous = await app.request(executeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Unauthorized" });

    const user = await app.request(executeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": "user", "x-test-user": "user-a" },
      body: "{}",
    });
    expect(user.status).toBe(403);
    expect(await user.json()).toEqual({ error: "Forbidden" });
  });

  test("returns controlled 400 responses for malformed JSON and body shapes", async () => {
    for (const url of objectBodyUrls) {
      const malformed = await app.request(url, { method: "POST", headers: ownerHeaders, body: "{" });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "Invalid JSON body" });

      const arrayBody = await app.request(url, { method: "POST", headers: ownerHeaders, body: "[]" });
      expect(arrayBody.status).toBe(400);
      expect(await arrayBody.json()).toEqual({ error: "JSON body must be an object" });
    }

    const malformedScope = await app.request(executeUrl, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ dataDir: process.cwd(), targetUserId: "owner-a", scope: "connections" }),
    });
    expect(malformedScope.status).toBe(400);
    expect(await malformedScope.json()).toEqual({ error: "scope is required" });
  });

  test("prevents admins from targeting privileged accounts", async () => {
    const response = await app.request(executeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-role": "admin", "x-test-user": "admin-a" },
      body: JSON.stringify({ dataDir: process.cwd(), targetUserId: "owner-a", scope: { connections: true } }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Admins can only migrate to their own account or user-role accounts" });
  });

  test("does not reflect secret-bearing malformed input in responses", async () => {
    const secret = "route-secret-must-not-leak";
    const response = await app.request(executeUrl, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ dataDir: "Z:/definitely-missing", targetUserId: "owner-a", scope: { connections: true }, password: secret }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(secret);
  });

  test("uploads, scans, and discards a web user-folder ZIP", async () => {
    const archive = zipSync({
      "characters/Alice.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "cache/ignored.bin": new Uint8Array([1, 2, 3]),
    });
    const uploaded = await app.request(
      "http://localhost/st-migration/backup?filename=default-user.zip",
      {
        method: "PUT",
        headers: { ...ownerHeaders, "content-type": "application/zip" },
        body: archive.buffer as ArrayBuffer,
      },
    );

    expect(uploaded.status).toBe(201);
    const result = await uploaded.json() as { uploadId: string; fileName: string; counts: { characters: number } };
    expect(result.fileName).toBe("default-user.zip");
    expect(result.counts.characters).toBe(1);

    const discarded = await app.request(`http://localhost/st-migration/backup/${result.uploadId}`, {
      method: "DELETE",
      headers: ownerHeaders,
    });
    expect(discarded.status).toBe(204);
  });
});
