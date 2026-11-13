import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { WorkerHost } from "./worker-host";
import {
  providerRegistry,
  type BrokerRequest,
  type ProviderKey,
} from "./provider-registry";

const DB_DIR = join(tmpdir(), "lumiverse-worker-host-provider-rpc-test-");
const DB_PATH = join(DB_DIR, "test.db");

beforeAll(async () => {
  initDatabase(DB_PATH);
  await runMigrations(getDb());
  getDb().run(
    `INSERT OR IGNORE INTO "user" (id, name, email) VALUES
      ('alice', 'Alice', 'alice@example.test'),
      ('bob', 'Bob', 'bob@example.test'),
      ('op-1', 'Operator', 'op@example.test')`,
  );
});

afterAll(() => {
  closeDatabase();
  rmSync(DB_DIR, { recursive: true, force: true });
});

// Provider registration now requires the scoped
// providers.<kind>.register grant, so seed grants for every
// (extension, kind) the RPC tests register.
function seedRegisterGrant(
  identifier: string,
  scope: "user" | "operator",
  userId: string | null,
  kinds: readonly string[],
): void {
  const db = getDb();
  db.run(
    `INSERT OR IGNORE INTO extensions (id, identifier, name, version, author, github, install_scope, installed_by_user_id)
     VALUES (?, ?, ?, '1.0.0', 'test', 'https://example.test/ext', ?, ?)`,
    [identifier, identifier, identifier, scope, userId],
  );
  const effectiveScope = userId ? `${scope}:${userId}` : scope;
  for (const kind of kinds) {
    db.run(
      `INSERT OR IGNORE INTO extension_grants (id, extension_id, permission, scope)
       VALUES (?, (SELECT id FROM extensions WHERE identifier = ?), ?, ?)`,
      [crypto.randomUUID(), identifier, `providers.${kind}.register`, effectiveScope],
    );
  }
}

const ALL_KINDS = ["embedding", "tts", "stt", "sidecar"] as const;

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

describe("worker-host provider RPC", () => {
  test("does not trust worker supplied user or owner", () => {
    seedRegisterGrant("ext.a", "user", "alice", ["embedding"]);
    const host = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    attachRuntime(host);
    handle(host, {
      type: "provider_register",
      phase: "register",
      kind: "embedding",
      id: "foo",
      userId: "attacker",
      owner: "attacker",
    });

    expect(providerRegistry.list("user:alice")).toHaveLength(1);
    expect(providerRegistry.list("user:attacker")).toHaveLength(0);
    expect(providerRegistry.get({
      effectiveScope: "user:alice",
      installationId: "inst-a",
      kind: "embedding",
      id: "foo",
    })?.key.effectiveScope).toBe("user:alice");
  });

  test("isolates list and invoke across users and shared operator installations", async () => {
    seedRegisterGrant("ext.a", "user", "alice", ["tts"]);
    seedRegisterGrant("ext.b", "user", "bob", ["tts"]);
    seedRegisterGrant("ext.op", "operator", "op-1", ["tts"]);
    const userA = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    const userB = new WorkerHost("inst-b", manifest("ext.b"), extensionInfo("ext.b", "user", "bob"));
    const operator = new WorkerHost("inst-op", manifest("ext.op"), extensionInfo("ext.op", "operator", "op-1"));
    attachRuntime(userA);
    attachRuntime(userB);
    attachRuntime(operator);

    handle(userA, { type: "provider_register", phase: "register", kind: "tts", id: "voice" });
    handle(userB, { type: "provider_register", phase: "register", kind: "tts", id: "voice" });
    handle(operator, { type: "provider_register", phase: "register", kind: "tts", id: "voice" });

    expect(providerRegistry.list("user:alice").map((row) => row.key.installationId)).toEqual(["inst-a"]);
    expect(providerRegistry.list("user:bob").map((row) => row.key.installationId)).toEqual(["inst-b"]);
    expect(providerRegistry.list("operator:op-1").map((row) => row.key.installationId)).toEqual(["inst-op"]);

    const bobKey: ProviderKey = {
      effectiveScope: "user:bob",
      installationId: "inst-b",
      kind: "tts",
      id: "voice",
    };
    await expect(providerRegistry.invoke(bobKey, {}, { callerScope: "user:alice" })).rejects.toThrow(/isolated/);
    await expect(
      providerRegistry.invoke(
        { effectiveScope: "operator:op-1", installationId: "inst-op", kind: "tts", id: "voice" },
        {},
        { callerScope: "user:alice" },
      ),
    ).rejects.toThrow(/isolated/);
  });

  test("aborts timed-out invocations and suppresses late provider_result", async () => {
    providerRegistry.configure({ timeoutMs: 20 });
    seedRegisterGrant("ext.a", "user", "alice", ["stt"]);
    const host = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    const posted = attachRuntime(host);
    handle(host, { type: "provider_register", phase: "register", kind: "stt", id: "transcribe" });

    const key: ProviderKey = {
      effectiveScope: "user:alice",
      installationId: "inst-a",
      kind: "stt",
      id: "transcribe",
    };
    const pending = providerRegistry.invoke(key, { audio: "clip" }, {
      callerScope: "user:alice",
      correlationId: "host-timeout",
    });
    await expect(pending).rejects.toThrow(/timed out/);
    handle(host, {
      type: "provider_result",
      phase: "result",
      correlationId: "host-timeout",
      round: 1,
      result: { text: "late" },
    });
    expect(posted.some((message) => (message as { type?: string }).type === "provider_abort")).toBe(true);
  });

  test("authenticated embedding/TTS/STT/sidecar two-stage broker redacts worker envelopes", async () => {
    const secretCalls: string[] = [];
    const fetchCalls: Array<{ url: string; authorization?: string }> = [];
    seedRegisterGrant("ext.a", "user", "alice", ALL_KINDS);
    const host = new WorkerHost("inst-a", manifest("ext.a"), extensionInfo("ext.a", "user", "alice"));
    const posted = attachRuntime(host);
    providerRegistry.configure({
      getSecret: async (_userId, key) => {
        secretCalls.push(key);
        return "sk-live";
      },
      fetch: async (url, options) => {
        const headers = new Headers(options?.headers);
        fetchCalls.push({ url, authorization: headers.get("Authorization") ?? undefined });
        return new Response(JSON.stringify({ ok: true, kind: url }), {
          status: 200,
          headers: { "content-type": "application/json", authorization: "Bearer sk-live" },
        });
      },
    });

    for (const kind of ["embedding", "tts", "stt", "sidecar"] as const) {
      const secretKey = `extension:inst-a:${kind}-secret`;
      handle(host, {
        type: "provider_register",
        phase: "register",
        kind,
        id: `${kind}-1`,
        broker: {
          kind,
          url: `https://provider.test/${kind}`,
          secretKey,
          headers: { Accept: "application/json" },
        },
      });
      const prepared = providerRegistry.prepareBroker({
        kind,
        url: `https://provider.test/${kind}`,
        secretKey,
        headers: { Accept: "application/json" },
        body: { input: kind },
        correlationId: `${kind}-corr`,
      } satisfies BrokerRequest, {
        installScope: "user",
        authenticatedSubject: "alice",
        installationId: "inst-a",
      });
      expect(prepared.workerView.secretKey).toBeUndefined();
      expect((prepared.workerView.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      const completed = await providerRegistry.completeBroker(prepared);
      expect(completed.ok).toBe(true);
      expect(completed.headers?.authorization).toBeUndefined();
    }

    expect(secretCalls).toEqual([
      "extension:inst-a:embedding-secret",
      "extension:inst-a:tts-secret",
      "extension:inst-a:stt-secret",
      "extension:inst-a:sidecar-secret",
    ]);
    expect(fetchCalls.every((call) => call.authorization === "Bearer sk-live")).toBe(true);
    expect(posted.every((message) => !JSON.stringify(message).includes("sk-live"))).toBe(true);
  });
});
