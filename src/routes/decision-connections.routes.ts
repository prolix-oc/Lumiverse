import { Hono } from "hono";
import { listDecisionProviders } from "../decisions/registry";
import * as svc from "../services/decision-connections.service";
import { withReadableApiKeyStatus } from "../services/connection-secret-status";

const app = new Hono();

app.get("/presets", (c) => c.json({ providers: listDecisionProviders().map(({ id, displayName, protocols, presets }) => ({ id, name: displayName, protocols, presets })) }));
app.post("/models/preview", async (c) => {
  try {
    return c.json(await svc.previewModels(c.get("userId"), await c.req.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load decision models";
    return c.json({ error: message }, message === "Decision connection not found" ? 404 : /model list returned HTTP|Gateway returned/.test(message) ? 502 : 400);
  }
});
app.get("/", async (c) => c.json({ data: await Promise.all(svc.listConnections(c.get("userId")).map((connection) => withReadableApiKeyStatus(c.get("userId"), connection, svc.decisionConnectionSecretKey))) }));
app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const connection = svc.getConnection(userId, c.req.param("id"));
  return connection ? c.json(await withReadableApiKeyStatus(userId, connection, svc.decisionConnectionSecretKey)) : c.json({ error: "Not found" }, 404);
});
app.post("/", async (c) => {
  try {
    const connection = await svc.createConnection(c.get("userId"), await c.req.json());
    return c.json(connection, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid connection" }, 400);
  }
});
app.put("/:id", async (c) => {
  try {
    const connection = await svc.updateConnection(c.get("userId"), c.req.param("id"), await c.req.json());
    return connection ? c.json(connection) : c.json({ error: "Not found" }, 404);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid connection" }, 400);
  }
});
app.post("/:id/duplicate", async (c) => {
  const connection = await svc.duplicateConnection(c.get("userId"), c.req.param("id"));
  return connection ? c.json(connection, 201) : c.json({ error: "Not found" }, 404);
});
app.post("/:id/default", async (c) => {
  const connection = await svc.updateConnection(c.get("userId"), c.req.param("id"), { is_default: true });
  return connection ? c.json(connection) : c.json({ error: "Not found" }, 404);
});
app.post("/:id/test", async (c) => c.json(await svc.testConnection(c.get("userId"), c.req.param("id"))));
app.delete("/:id", (c) => svc.deleteConnection(c.get("userId"), c.req.param("id")) ? c.json({ success: true }) : c.json({ error: "Not found" }, 404));

export const decisionConnectionsRoutes = app;
