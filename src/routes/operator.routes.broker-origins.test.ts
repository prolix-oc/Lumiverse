import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Keep this route-policy test independent from the optional BetterAuth runtime.
// The production app supplies the real session middleware; this test only needs
// its owner decision.
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

const { operatorRoutes } = await import("./operator.routes");
const { providerRegistry } = await import("../spindle/provider-registry");
const { getApprovedBrokerOrigins } = await import("../services/broker-origins.service");

const USER_ID = "broker-origins-route-owner";

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

describe("PUT /broker-origins live enforcement", () => {
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
    providerRegistry.reset();
    providerRegistry.configure({ approvedBrokerOrigins: [] });
  });

  afterEach(() => {
    providerRegistry.reset();
    providerRegistry.configure({ approvedBrokerOrigins: [] });
    closeDatabase();
  });

  test("tightened allowlist is enforced by the singleton registry without restart", async () => {
    const app = createTestApp();

    // Baseline: permissive allowlist accepts the soon-to-be-unapproved origin.
    expect(() =>
      providerRegistry.register(
        {
          kind: "embedding",
          id: "pre-tighten",
          broker: { kind: "embedding", url: "https://evil.test/embed" },
        },
        { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
      ),
    ).not.toThrow();
    providerRegistry.reset();

    const response = await app.request("http://localhost/broker-origins", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origins: ["https://good.test:8443"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: ["https://good.test:8443"] });
    expect(getApprovedBrokerOrigins()).toEqual(["https://good.test:8443"]);

    // Without restart, the now-unapproved origin is rejected at registration.
    expect(() =>
      providerRegistry.register(
        {
          kind: "embedding",
          id: "post-tighten",
          broker: { kind: "embedding", url: "https://evil.test/embed" },
        },
        { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
      ),
    ).toThrow(/not approved/);

    // The approved origin still registers.
    expect(() =>
      providerRegistry.register(
        {
          kind: "embedding",
          id: "post-tighten-approved",
          broker: { kind: "embedding", url: "https://good.test:8443/embed" },
        },
        { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
      ),
    ).not.toThrow();
  });

  test("clearing the list restores permissive registration without restart", async () => {
    const app = createTestApp();

    const tighten = await app.request("http://localhost/broker-origins", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origins: ["https://good.test"] }),
    });
    expect(tighten.status).toBe(200);
    expect(() =>
      providerRegistry.register(
        {
          kind: "embedding",
          id: "tightened",
          broker: { kind: "embedding", url: "https://evil.test/embed" },
        },
        { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
      ),
    ).toThrow(/not approved/);

    const clear = await app.request("http://localhost/broker-origins", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origins: [] }),
    });
    expect(clear.status).toBe(200);

    expect(() =>
      providerRegistry.register(
        {
          kind: "embedding",
          id: "cleared",
          broker: { kind: "embedding", url: "https://evil.test/embed" },
        },
        { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
      ),
    ).not.toThrow();
  });

  test("invalid payload rejects with 400 and leaves the live allowlist untouched", async () => {
    const app = createTestApp();

    const seed = await app.request("http://localhost/broker-origins", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origins: ["https://good.test"] }),
    });
    expect(seed.status).toBe(200);

    const bad = await app.request("http://localhost/broker-origins", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origins: ["not-a-url"] }),
    });
    expect(bad.status).toBe(400);

    expect(() =>
      providerRegistry.register(
        {
          kind: "embedding",
          id: "after-invalid",
          broker: { kind: "embedding", url: "https://evil.test/embed" },
        },
        { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
      ),
    ).toThrow(/not approved/);
  });
});
