import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Keep this route-policy test independent from the BetterAuth runtime.
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

// Deterministic AES-256 key so putSecret works without a real identity file.
mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

mock.module("../auth", () => ({
  auth: {},
  allowCreation: () => "test-nonce",
  CREATION_NONCE_HEADER: "x-lumiverse-creation-nonce",
}));

// The purge pipeline fans out into LanceDB/MCP/generation subsystems; this is
// a route-policy test, so stub it with the row deletion it performs.
mock.module("../services/user-data/purge.service", () => ({
  purgeUser: async (id: string) => {
    getDb().run('DELETE FROM "user" WHERE id = ?', [id]);
    return { userId: id, tables: [], files: [] };
  },
}));

const { usersRoutes } = await import("./users.routes");
const {
  putSecret,
  SYSTEM_SECRET_PRINCIPAL,
  SYSTEM_SECRET_PRINCIPAL_EMAIL,
} = await import("../services/secrets.service");

const OWNER_ID = "admin-owner";

function createTestApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session", {
      user: { id: OWNER_ID, role: "owner" },
      session: { id: "session-1", userId: OWNER_ID, token: "test", expiresAt: new Date(Date.now() + 60_000) },
    } as never);
    c.set("userId", OWNER_ID);
    await next();
  });
  app.route("/", usersRoutes);
  return app;
}

function insertUser(id: string, email: string, role: string, createdAt: number): void {
  getDb()
    .query(
      `INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, id, email, role, createdAt, createdAt);
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  const baseline = await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text();
  getDb().run(baseline);
});

afterEach(() => {
  closeDatabase();
});

describe("admin user routes vs reserved system principal", () => {
  test("user listing excludes the reserved system principal", async () => {
    insertUser(OWNER_ID, "owner@lumiverse.local", "owner", 100);
    insertUser("u2", "u2@lumiverse.local", "user", 200);
    // Legacy shape sorts first but must never surface as an account.
    insertUser(SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL, "system", 0);

    const app = createTestApp();
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string }>;

    expect(rows.map((r) => r.id).sort()).toEqual([OWNER_ID, "u2"].sort());
    expect(rows.some((r) => r.id === SYSTEM_SECRET_PRINCIPAL)).toBe(false);
  });

  test("DELETE of the system principal is rejected with 409 without cascading secrets", async () => {
    insertUser(OWNER_ID, "owner@lumiverse.local", "owner", 100);
    await putSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:key1", "sk-live");

    const app = createTestApp();
    const res = await app.request(`http://localhost/${SYSTEM_SECRET_PRINCIPAL}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("system principal");

    // Row AND its operator-provisioned broker secrets survive.
    expect(
      getDb().query('SELECT COUNT(*) as count FROM "user" WHERE id = ?').get(SYSTEM_SECRET_PRINCIPAL),
    ).toEqual({ count: 1 });
    expect(
      getDb().query("SELECT COUNT(*) as count FROM secrets WHERE user_id = ?").get(SYSTEM_SECRET_PRINCIPAL),
    ).toEqual({ count: 1 });
  });

  test("DELETE rejects the system principal even when no row exists yet", async () => {
    insertUser(OWNER_ID, "owner@lumiverse.local", "owner", 100);

    const app = createTestApp();
    const res = await app.request(`http://localhost/${SYSTEM_SECRET_PRINCIPAL}`, { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  test("deleting a regular user still works", async () => {
    insertUser(OWNER_ID, "owner@lumiverse.local", "owner", 100);
    insertUser("u2", "u2@lumiverse.local", "user", 200);

    const app = createTestApp();
    const res = await app.request("http://localhost/u2", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(
      getDb().query('SELECT COUNT(*) as count FROM "user" WHERE id = ?').get("u2"),
    ).toEqual({ count: 0 });
  });
});
