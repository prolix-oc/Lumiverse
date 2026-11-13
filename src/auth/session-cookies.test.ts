import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { forwardSessionCookies } from "./session-cookies";

describe("session cookie forwarding", () => {
  test("copies Better Auth renewal cookies onto the protected API response", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      const authHeaders = new Headers();
      authHeaders.append("Set-Cookie", "lumiverse.session_token=renewed; Path=/; HttpOnly");
      forwardSessionCookies(c, authHeaders);
      return c.json({ ok: true });
    });

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("lumiverse.session_token=renewed");
  });

  test("does not leak unrelated get-session response headers", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      forwardSessionCookies(c, new Headers({
        "Cache-Control": "no-store",
        "X-Internal-Auth": "hidden",
      }));
      return c.json({ ok: true });
    });

    const response = await app.request("/");

    expect(response.headers.get("x-internal-auth")).toBeNull();
  });
});
