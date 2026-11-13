import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Keep this route-policy test independent from the optional BetterAuth runtime.
mock.module("../auth/middleware", () => ({
  requireOwner: async (c: any, next: any) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (session.user.role !== "owner" && session.user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  },
}));

// Deterministic AES-256 key so putSecret/getSecret work without a real
// identity file on disk.
mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

const { operatorRoutes } = await import("./operator.routes");
const { getSecret, putSecret, SYSTEM_SECRET_PRINCIPAL } = await import("../services/secrets.service");

const USER_ID = "spindle-secrets-route-owner";

function createTestApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session", {
      user: { id: USER_ID, role: "owner" },
      session: { id: "session-1", userId: USER_ID, token: "test", expiresAt: new Date(Date.now() + 60_000) },
    } as never);
    c.set("userId", USER_ID);
    await next();
  });
  app.route("/", operatorRoutes);
  return app;
}

describe("operator /spindle-secrets routes", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    const baseline = await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text();
    getDb().run(baseline);
    getDb()
      .query(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
      )
      .run(USER_ID, "Owner", "owner@example.com");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("PUT rejects non-string and empty values with 400 before encrypting", async () => {
    const app = createTestApp();

    for (const value of [{ nested: true }, 42, "", null]) {
      const response = await app.request("http://localhost/spindle-secrets/extension:inst-a:key1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      expect(response.status).toBe(400);
    }

    // Nothing was persisted.
    expect(await getSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:key1")).toBeNull();
  });

  test("PUT stores a valid string secret under the system principal", async () => {
    const app = createTestApp();

    const response = await app.request("http://localhost/spindle-secrets/extension:inst-a:key1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-live" }),
    });
    expect(response.status).toBe(200);
    expect(await getSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:key1")).toBe("sk-live");
  });

  test("GET lists system-principal extension keys with parsed namespaces", async () => {
    const app = createTestApp();

    await putSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:alpha", "v1");
    await putSecret(SYSTEM_SECRET_PRINCIPAL, "not-an-extension-key", "v2");

    const response = await app.request("http://localhost/spindle-secrets");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      keys: Array<{ key: string; installationId: string; name: string }>;
    };
    expect(body.keys).toEqual([
      { key: "extension:inst-a:alpha", installationId: "inst-a", name: "alpha" },
    ]);
  });

  test("DELETE purges a system-principal extension row and rejects malformed keys", async () => {
    const app = createTestApp();
    await putSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:rotated", "old");

    const bad = await app.request("http://localhost/spindle-secrets/global_key", {
      method: "DELETE",
    });
    expect(bad.status).toBe(400);

    const del = await app.request("http://localhost/spindle-secrets/extension:inst-a:rotated", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true, deleted: true });
    expect(await getSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:rotated")).toBeNull();

    // Deleting again reports no-op without error.
    const repeat = await app.request("http://localhost/spindle-secrets/extension:inst-a:rotated", {
      method: "DELETE",
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ success: true, deleted: false });
  });
});
