import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// The auth singleton requires an initialized application database at import
// time. These route tests exercise requireOwnerStrict directly, so stub only
// that singleton and keep the production middleware implementation intact.
mock.module("../auth/index", () => ({ auth: { api: {} } }));

const { embeddingsRoutes } = await import("./embeddings.routes");

const OWNER_ONLY_VECTOR_ROUTES = [
  { method: "POST", path: "/force-reset" },
  { method: "POST", path: "/optimize" },
  { method: "GET", path: "/health" },
  { method: "GET", path: "/vector-store/config" },
  { method: "PUT", path: "/vector-store/config" },
  { method: "POST", path: "/vector-store/test" },
  { method: "POST", path: "/vector-store/switch" },
] as const;

function appForRole(role: "user" | "admin") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session", {
      user: {
        id: `${role}-id`,
        name: role,
        email: `${role}@example.test`,
        role,
      },
      session: {
        id: `${role}-session-id`,
        userId: `${role}-id`,
        token: `${role}-token`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    c.set("userId", `${role}-id`);
    return next();
  });
  app.route("/", embeddingsRoutes);
  return app;
}

describe("embeddings vector-store route authorization", () => {
  for (const role of ["user", "admin"] as const) {
    for (const route of OWNER_ONLY_VECTOR_ROUTES) {
      test(`rejects ${role} access to ${route.method} ${route.path}`, async () => {
        const response = await appForRole(role).request(route.path, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: route.method === "GET" ? undefined : JSON.stringify({}),
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "Forbidden" });
      });
    }
  }
});
