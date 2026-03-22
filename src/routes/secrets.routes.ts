import { Hono } from "hono";
import * as svc from "../services/secrets.service";

const SECRET_KEY_RE = /^[a-zA-Z0-9_\-]{1,255}$/;

const app = new Hono();

app.get("/", (c) => {
  const userId = c.get("userId");
  return c.json(svc.listSecretKeys(userId));
});

app.put("/:key", async (c) => {
  const userId = c.get("userId");
  const key = c.req.param("key");
  if (!SECRET_KEY_RE.test(key)) return c.json({ error: "Invalid key format" }, 400);
  const body = await c.req.json();
  if (!body.value) return c.json({ error: "value is required" }, 400);
  await svc.putSecret(userId, key, body.value);
  return c.json({ success: true });
});

app.delete("/:key", (c) => {
  const userId = c.get("userId");
  const key = c.req.param("key");
  if (!SECRET_KEY_RE.test(key)) return c.json({ error: "Invalid key format" }, 400);
  const deleted = svc.deleteSecret(userId, key);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.post("/:key/validate", async (c) => {
  const userId = c.get("userId");
  const key = c.req.param("key");
  if (!SECRET_KEY_RE.test(key)) return c.json({ error: "Invalid key format" }, 400);
  const valid = await svc.validateSecret(userId, key);
  return c.json({ valid });
});

export { app as secretsRoutes };
