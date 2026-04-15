import { Hono } from "hono";
import * as svc from "../services/settings.service";
import { InvalidSettingError } from "../services/settings.service";

const app = new Hono();

app.get("/", (c) => {
  const userId = c.get("userId");
  return c.json(svc.getAllSettings(userId));
});

app.get("/:key", (c) => {
  const userId = c.get("userId");
  const setting = svc.getSetting(userId, c.req.param("key"));
  if (!setting) return c.json({ error: "Not found" }, 404);
  return c.json(setting);
});

// Bulk upsert — PUT /settings { key1: value1, key2: value2, ... }
app.put("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const results = svc.putMany(userId, body);
    return c.json(results);
  } catch (err: any) {
    if (err instanceof InvalidSettingError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.put("/:key", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const setting = svc.putSetting(userId, c.req.param("key"), body.value);
    return c.json(setting);
  } catch (err: any) {
    if (err instanceof InvalidSettingError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.delete("/:key", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteSetting(userId, c.req.param("key"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as settingsRoutes };
