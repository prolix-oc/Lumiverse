import { Hono } from "hono";
import * as connSvc from "../services/connections.service";
import * as svc from "../services/nanogpt.service";
import { describeProviderError } from "../utils/provider-errors";

const app = new Hono();

app.get("/account", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const connectionId = c.req.query("connection_id");
  if (!connectionId) return c.json({ error: "connection_id is required" }, 400);
  try {
    return c.json(await svc.fetchAccountUsage(c.get("userId"), connectionId));
  } catch (err) {
    return c.json({ error: describeProviderError(err, "Failed to fetch NanoGPT account") }, err instanceof svc.NanoGptConnectionError ? err.status : 502);
  }
});

app.post("/providers/preview", async (c) => {
  const body = await c.req.json();
  if (typeof body?.model !== "string" || !body.model.trim()) return c.json({ error: "model is required" }, 400);
  for (const key of ["connection_id", "api_url", "api_key"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") return c.json({ error: `${key} must be a string` }, 400);
  }
  try {
    return c.json(await svc.discoverModelProviders(c.get("userId"), body));
  } catch (err) {
    return c.json({ error: describeProviderError(err, "Failed to discover NanoGPT providers") }, err instanceof svc.NanoGptConnectionError ? err.status : 502);
  }
});

app.get("/auth", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.query("connection_id");
  const connectionName = c.req.query("connection_name");
  const callbackUrl = c.req.query("callback_url");

  if (!connectionId && !connectionName) return c.json({ error: "connection_id or connection_name is required" }, 400);
  if (!callbackUrl) return c.json({ error: "callback_url is required" }, 400);

  if (connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn) return c.json({ error: "Connection not found" }, 404);
    if (conn.provider !== "nanogpt") return c.json({ error: "Connection is not a NanoGPT profile" }, 400);
  }

  const result = await svc.initiateOAuthAsync(callbackUrl, { connectionId, connectionName });
  return c.json(result);
});

app.post("/auth/callback", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { session_token, code } = body;

  if (!session_token || !code) return c.json({ error: "session_token and code are required" }, 400);

  try {
    const result = await svc.completeOAuth(userId, session_token, code);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || "OAuth exchange failed" }, 400);
  }
});

export { app as nanogptRoutes };
