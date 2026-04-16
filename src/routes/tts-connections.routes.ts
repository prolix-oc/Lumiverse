import { Hono } from "hono";
import * as svc from "../services/tts-connections.service";
import { getTtsProviderList } from "../tts/registry";
import { parsePagination } from "../services/pagination";

// Side-effect import: registers all TTS providers in the registry
import "../tts/index";

const app = new Hono();

/** List all TTS providers with capabilities */
app.get("/providers", (c) => {
  const providers = getTtsProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    capabilities: p.capabilities,
  }));
  return c.json({ providers });
});

/** List TTS connections (paginated) */
app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listConnections(userId, pagination));
});

/** Create TTS connection */
app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) {
    return c.json({ error: "name and provider are required" }, 400);
  }
  const conn = await svc.createConnection(userId, body);
  return c.json(conn, 201);
});

/** Get TTS connection by ID */
app.get("/:id", (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

/** Update TTS connection */
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const conn = await svc.updateConnection(userId, c.req.param("id"), body);
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

/** Delete TTS connection */
app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!(await svc.deleteConnection(userId, c.req.param("id")))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ success: true });
});

/** Test TTS connection */
app.post("/:id/test", async (c) => {
  const userId = c.get("userId");
  const result = await svc.testConnection(userId, c.req.param("id"));
  return c.json(result);
});

/** List available models for connection */
app.get("/:id/models", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionModels(userId, c.req.param("id"));
  return c.json(result);
});

/** List available voices for connection */
app.get("/:id/voices", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionVoices(userId, c.req.param("id"));
  return c.json(result);
});

/** Set or update API key */
app.put("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.api_key) return c.json({ error: "api_key is required" }, 400);
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.setConnectionApiKey(userId, c.req.param("id"), body.api_key);
  return c.json({ success: true });
});

/** Remove API key */
app.delete("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.clearConnectionApiKey(userId, c.req.param("id"));
  return c.json({ success: true });
});

/** Duplicate TTS connection */
app.post("/:id/duplicate", async (c) => {
  const userId = c.get("userId");
  const conn = await svc.duplicateConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn, 201);
});

export { app as ttsConnectionsRoutes };
