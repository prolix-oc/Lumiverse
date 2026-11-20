import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as svc from "../services/settings.service";
import { reconcileActiveLoomPresetAsync } from "../services/presets.service";
import { InvalidSettingError } from "../services/settings.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const app = new Hono();

app.get("/", async (c) => {
  const userId = c.get("userId");
  // A preset may have been deleted from another session while this browser
  // was closed. Repair the persisted selection before returning hydration
  // settings so the client never restores a ghost preset id after refresh.
  await reconcileActiveLoomPresetAsync(userId);
  return c.json(await svc.getAllSettingsAsync(userId));
});

app.get("/:key", async (c) => {
  const userId = c.get("userId");
  const setting = await svc.getSettingAsync(userId, c.req.param("key"));
  if (!setting) return c.json({ error: "Not found" }, 404);
  return c.json(setting);
});

// Saved theme packs can include base64-encoded fonts and images. Keep this
// wider request limit isolated from the normal settings API, which remains
// protected by the application-wide 10 MB body guard.
app.put(
  "/saved-themes",
  bodyLimit({
    maxSize: svc.MAX_SAVED_THEMES_VALUE_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
  async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json();
    try {
      return c.json(await svc.putSettingAsync(userId, "savedThemes", body.value));
    } catch (err: any) {
      if (err instanceof InvalidSettingError) return c.json({ error: err.message }, 400);
      throw err;
    }
  },
);

// Bulk upsert — PUT /settings { key1: value1, key2: value2, ... }
app.put("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const results = await svc.putManyAsync(userId, body);
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
    const setting = await svc.putSettingAsync(userId, c.req.param("key"), body.value);
    return c.json(setting);
  } catch (err: any) {
    if (err instanceof InvalidSettingError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.delete("/:key", async (c) => {
  const userId = c.get("userId");
  const deleted = await svc.deleteSettingAsync(userId, c.req.param("key"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  eventBus.emit(EventType.SETTINGS_UPDATED, { key: c.req.param("key") }, userId);
  return c.json({ success: true });
});

export { app as settingsRoutes };
