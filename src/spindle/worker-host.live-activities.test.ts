import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { WorkerHost } from "./worker-host";

const directory = mkdtempSync(join(tmpdir(), "spindle-activity-host-"));
beforeAll(async () => {
  initDatabase(join(directory, "test.db"));
  await runMigrations(getDb());
  getDb().exec(`INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@example.test'), ('other', 'Other', 'other@example.test');
    INSERT INTO ios_push_destinations (id, user_id, device_id, device_token, bundle_id, environment, server_origin, registered_at, encryption_key, encryption_key_id)
      VALUES ('device', 'owner', 'installation', 'token', 'chat.lumiverse.ios', 'development', 'https://example.test', 1, 'sealed-key', 'key-id');
    INSERT INTO spindle_live_activity_clients VALUES ('device', 1);`);
});
afterAll(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

function host(id: string, scope: "user" | "operator") {
  getDb().query(`INSERT INTO extensions (id, identifier, name, version, author, github, install_scope, installed_by_user_id)
    VALUES (?, ?, ?, '1.0.0', 'test', 'https://example.test/ext', ?, 'owner')`).run(id, id, id, scope);
  const info: ExtensionInfo = {
    id, identifier: id, name: id, version: "1.0.0", author: "test", description: "", github: "", homepage: "",
    permissions: [], granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: scope, installed_by_user_id: "owner" },
  };
  const instance = new WorkerHost(id, { identifier: id, name: id, version: "1.0.0", author: "test", description: "" } as SpindleManifest, info);
  const posted: { requestId?: string; error?: string; result?: any }[] = [];
  const pending = new Map<string, (message: typeof posted[number]) => void>();
  (instance as any).runtime = { mode: "worker", pid: null, postMessage: (message: any) => {
    posted.push(message); pending.get(message.requestId)?.(message); pending.delete(message.requestId);
  }, terminate() {} };
  return {
    instance, posted,
    async request(requestId: string, operation = "status", userId?: string, rpcPermissionScopeId?: string) {
      return await new Promise<typeof posted[number]>(resolve => {
        pending.set(requestId, resolve);
        (instance as any).handleMessage({ type: "live_activity", requestId, operation, userId, rpcPermissionScopeId });
      });
    },
    grant() {
      getDb().query("INSERT INTO extension_grants (id, extension_id, permission, scope) VALUES (?, ?, 'push_notification', ?)")
        .run(crypto.randomUUID(), id, scope + ":owner");
    },
  };
}

test("Live Activity RPCs use live notification grants, including delegated scopes and revocation", async () => {
  const worker = host("permissions", "user");
  expect((await worker.request("denied", "start")).error).toContain("push_notification");
  worker.grant();
  expect((await worker.request("allowed")).result.enrolledDevices).toBe(1);
  (worker.instance as any).sharedRpcPermissionScopes.set("limited", new Set());
  expect((await worker.request("limited", "status", undefined, "limited")).error).toContain("push_notification");
  getDb().query("DELETE FROM extension_grants WHERE extension_id = ?").run("permissions");
  expect((await worker.request("revoked", "end")).error).toContain("push_notification");
  expect(getDb().query("SELECT COUNT(*) AS count FROM spindle_live_activities").get()).toEqual({ count: 0 });
});

test("user workers stay bound to their owner and operator workers must supply the target user", async () => {
  const user = host("user-scope", "user"); user.grant();
  expect((await user.request("owner", "status", "other")).result.enrolledDevices).toBe(1);
  const operator = host("operator-scope", "operator"); operator.grant();
  expect((await operator.request("missing")).error).toContain("userId is required");
  expect((await operator.request("other", "status", "other")).result.enrolledDevices).toBe(0);
});
