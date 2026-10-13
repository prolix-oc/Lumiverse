import { Hono } from "hono";
import * as connSvc from "../services/connections.service";
import * as svc from "../services/nanogpt.service";

const app = new Hono();

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
