import { Hono } from "hono";
import * as svc from "../services/connections.service";
import { parsePagination } from "../services/pagination";

const app = new Hono();

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listConnections(userId, pagination));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) return c.json({ error: "name and provider are required" }, 400);
  const conn = await svc.createConnection(userId, body);
  return c.json(conn, 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const conn = await svc.updateConnection(userId, c.req.param("id"), body);
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!(await svc.deleteConnection(userId, c.req.param("id")))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.post("/:id/test", async (c) => {
  const userId = c.get("userId");
  const result = await svc.testConnection(userId, c.req.param("id"));
  return c.json(result);
});

app.get("/:id/models", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionModels(userId, c.req.param("id"));
  return c.json(result);
});

app.put("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.api_key) return c.json({ error: "api_key is required" }, 400);
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.setConnectionApiKey(userId, c.req.param("id"), body.api_key);
  return c.json({ success: true });
});

app.delete("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.clearConnectionApiKey(userId, c.req.param("id"));
  return c.json({ success: true });
});

app.post("/:id/duplicate", async (c) => {
  const userId = c.get("userId");
  const conn = await svc.duplicateConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn, 201);
});

app.post("/pollinations/auth-url", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  const redirectUrl = String(body?.redirect_url || "").trim();
  if (!redirectUrl) return c.json({ error: "redirect_url is required" }, 400);

  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return c.json({ error: "redirect_url must be a valid URL" }, 400);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return c.json({ error: "redirect_url must use http or https" }, 400);
  }

  const auth_url = svc.buildPollinationsAuthorizeUrl(userId, {
    redirect_url: redirectUrl,
    models: body?.models ? String(body.models) : undefined,
    budget: typeof body?.budget === "number" ? body.budget : undefined,
    expiry: typeof body?.expiry === "number" ? body.expiry : undefined,
    permissions: body?.permissions ? String(body.permissions) : undefined,
  });

  return c.json({ auth_url });
});

export { app as connectionsRoutes };
