import { Hono } from "hono";
import { DecisionValidationError } from "../decision/validation";
import * as svc from "../services/decision-connections.service";
import * as oauth from "../services/decision-connection-oauth.service";
import { parsePagination } from "../services/pagination";
import { withReadableApiKeyStatus, withReadableApiKeyStatuses } from "../services/connection-secret-status";

const app = new Hono();
app.onError((error, c) => {
  const status = error instanceof DecisionValidationError || error instanceof SyntaxError ? 400 : 500;
  return c.json({ error: status === 400 ? error.message : "Decision connection operation failed" }, status);
});

app.get("/providers", (c) => {
  return c.json({ providers: svc.listProviders() });
});

app.post("/models/preview", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const result = await svc.listConnectionModelsPreview(userId, body);
  return c.json(result);
});

app.post("/auth/callback", async (c) => c.json(await oauth.completeOAuth(c.get("userId"), await c.req.json())));

app.post("/auth/:provider", async (c) => c.json(await oauth.initiateOAuth(
  // The app's origin middleware validates Origin before these routes. Prefer
  // it to the upstream URL, whose host can be rewritten by a reverse proxy.
  c.get("userId"), c.req.param("provider"), await c.req.json(), c.req.header("origin") || new URL(c.req.url).origin,
)));

app.get("/", async (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const result = await withReadableApiKeyStatuses(
    userId,
    svc.listConnections(userId, pagination),
    svc.decisionConnectionSecretKey,
  );
  return c.json(result);
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const conn = await svc.createConnection(userId, body);
  return c.json(await withReadableApiKeyStatus(userId, conn, svc.decisionConnectionSecretKey), 201);
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(await withReadableApiKeyStatus(userId, conn, svc.decisionConnectionSecretKey));
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const conn = await svc.updateConnection(userId, c.req.param("id"), body);
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(await withReadableApiKeyStatus(userId, conn, svc.decisionConnectionSecretKey));
});

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!(await svc.deleteConnection(userId, c.req.param("id")))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ success: true });
});

app.post("/:id/test", async (c) => {
  const userId = c.get("userId");
  const result = await svc.testConnection(userId, c.req.param("id"));
  return c.json(result);
});

app.post("/:id/sample", async (c) => c.json(await svc.runSampleDecision(c.get("userId"), c.req.param("id"))));

app.get("/:id/models", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionModels(userId, c.req.param("id"));
  return c.json(result);
});

app.put("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (typeof body?.api_key !== "string" || !body.api_key.trim()) return c.json({ error: "api_key is required" }, 400);
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
  return c.json(await withReadableApiKeyStatus(userId, conn, svc.decisionConnectionSecretKey), 201);
});

export { app as decisionConnectionsRoutes };
