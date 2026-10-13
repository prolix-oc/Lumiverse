import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { WorkerHost } from "./worker-host";
import { providerRegistry } from "./provider-registry";

const DB_DIR = join(tmpdir(), "lumiverse-worker-host-provider-perms-test-");
const DB_PATH = join(DB_DIR, "test.db");

beforeAll(async () => {
  initDatabase(DB_PATH);
  await runMigrations(getDb());
  getDb().run(
    `INSERT OR IGNORE INTO "user" (id, name, email) VALUES
      ('alice', 'Alice', 'alice@example.test'),
      ('op-1', 'Operator', 'op@example.test')`,
  );
});

afterAll(() => {
  closeDatabase();
  rmSync(DB_DIR, { recursive: true, force: true });
});

afterEach(() => {
  providerRegistry.reset();
  providerRegistry.configure({ timeoutMs: 30_000 });
  const db = getDb();
  db.run("DELETE FROM extension_grants");
  db.run("DELETE FROM extensions");
});

function manifest(identifier: string): SpindleManifest {
  return {
    identifier,
    name: identifier,
    version: "1.0.0",
    author: "test",
    description: "",
  } as SpindleManifest;
}

function extensionInfo(id: string, scope: "user" | "operator", userId: string | null): ExtensionInfo {
  return {
    id,
    identifier: id,
    name: id,
    version: "0.0.0",
    author: "",
    description: "",
    github: "",
    homepage: "",
    permissions: [],
    granted_permissions: [],
    enabled: true,
    installed_at: 0,
    updated_at: 0,
    has_frontend: false,
    has_backend: false,
    status: "stopped",
    metadata: {
      install_scope: scope,
      installed_by_user_id: userId,
    },
  };
}

function seedExtension(
  identifier: string,
  scope: "user" | "operator",
  userId: string | null,
  permissions: Array<{ permission: string; scope: string }> = [],
): void {
  const db = getDb();
  db.run(
    `INSERT INTO extensions (id, identifier, name, version, author, github, install_scope, installed_by_user_id)
     VALUES (?, ?, ?, '1.0.0', 'test', 'https://example.test/ext', ?, ?)`,
    [identifier, identifier, identifier, scope, userId],
  );
  for (const grant of permissions) {
    db.run(
      `INSERT INTO extension_grants (id, extension_id, permission, scope)
       VALUES (?, (SELECT id FROM extensions WHERE identifier = ?), ?, ?)`,
      [crypto.randomUUID(), identifier, grant.permission, grant.scope],
    );
  }
}

function attachRuntime(host: WorkerHost): unknown[] {
  const posted: unknown[] = [];
  (host as unknown as { runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void } }).runtime = {
    mode: "worker",
    pid: null,
    postMessage(message: unknown) {
      posted.push(message);
    },
    terminate() {},
  };
  return posted;
}

function handle(host: WorkerHost, message: unknown): void {
  (host as unknown as { handleMessage(msg: unknown): void }).handleMessage(message);
}

function findDenied(posted: unknown[], permission: string, operation: string): unknown {
  return posted.find(
    (message) =>
      (message as { type?: string; permission?: string; operation?: string }).type ===
        "permission_denied" &&
      (message as { permission?: string }).permission === permission &&
      (message as { operation?: string }).operation === operation,
  );
}

describe("worker-host provider register permission enforcement", () => {
  test("denies provider_register without the scoped register grant", () => {
    seedExtension("ext.a", "user", "alice");

    const host = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    const posted = attachRuntime(host);
    handle(host, { type: "provider_register", phase: "register", kind: "embedding", id: "foo" });

    expect(findDenied(posted, "providers.embedding.register", "provider_register")).toBeDefined();
    expect(providerRegistry.list("user:alice")).toHaveLength(0);
  });

  test("grants register into the worker's own scope while an ungranted operator scope stays isolated", () => {
    seedExtension("ext.a", "user", "alice", [
      { permission: "providers.embedding.register", scope: "user:alice" },
    ]);
    seedExtension("ext.op", "operator", "op-1");

    const userHost = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    attachRuntime(userHost);
    handle(userHost, {
      type: "provider_register",
      phase: "register",
      kind: "embedding",
      id: "foo",
    });
    expect(providerRegistry.list("user:alice").map((row) => row.key.id)).toEqual(["foo"]);

    const operatorHost = new WorkerHost("inst-op", manifest("ext.op"), extensionInfo("ext.op", "operator", "op-1"));
    const operatorPosted = attachRuntime(operatorHost);
    handle(operatorHost, {
      type: "provider_register",
      phase: "register",
      kind: "embedding",
      id: "foo",
    });
    expect(
      findDenied(operatorPosted, "providers.embedding.register", "provider_register"),
    ).toBeDefined();
    expect(providerRegistry.list("operator:op-1")).toHaveLength(0);
  });

  test("invalid or missing provider kind gets a clean invalid-request denial, not a malformed permission string", () => {
    seedExtension("ext.a", "user", "alice", [
      { permission: "providers.embedding.register", scope: "user:alice" },
    ]);

    const host = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    const posted = attachRuntime(host);

    handle(host, { type: "provider_register", phase: "register", kind: "", id: "foo" });
    handle(host, { type: "provider_register", phase: "register", kind: "bogus", id: "foo" } as never);
    handle(host, { type: "provider_unregister", phase: "unregister", kind: "", id: "foo" });

    for (const message of posted) {
      const m = message as { permission?: string };
      expect(m.permission).not.toBe("providers..register");
      expect(m.permission).not.toMatch(/\.\./);
    }
    const denials = posted.filter(
      (message) => (message as { type?: string }).type === "permission_denied",
    ) as Array<{ permission: string; operation: string }>;
    expect(denials).toHaveLength(3);
    expect(denials.every((d) => d.permission === "providers.register")).toBe(true);
    expect(denials.map((d) => d.operation)).toEqual([
      "provider_register",
      "provider_register",
      "provider_unregister",
    ]);
    expect(providerRegistry.list("user:alice")).toHaveLength(0);
  });

  test("denies provider_unregister without the grant and keeps the registration intact", () => {
    seedExtension("ext.a", "user", "alice", [
      { permission: "providers.tts.register", scope: "user:alice" },
    ]);

    const host = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    const posted = attachRuntime(host);
    handle(host, { type: "provider_register", phase: "register", kind: "tts", id: "voice" });
    expect(providerRegistry.list("user:alice")).toHaveLength(1);

    // Revoke the scoped grant, then attempt an unregister: must be denied and
    // must NOT remove the already-registered provider.
    getDb().run("DELETE FROM extension_grants");
    handle(host, { type: "provider_unregister", phase: "unregister", kind: "tts", id: "voice" });

    expect(findDenied(posted, "providers.tts.register", "provider_unregister")).toBeDefined();
    expect(
      providerRegistry.get({
        effectiveScope: "user:alice",
        installationId: "inst-a",
        kind: "tts",
        id: "voice",
      }),
    ).toBeDefined();
  });
});
