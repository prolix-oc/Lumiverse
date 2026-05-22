import { Hono } from "hono";
import { searchWebWithConfig } from "../services/web-search.service";
import {
  getWebSearchApiKey,
  getWebSearchSettings,
  normalizeWebSearchSettings,
  putWebSearchSettings,
  type WebSearchSettingsInput,
} from "../services/web-search-settings.service";

const app = new Hono();

// GET /api/v1/web-search/settings
app.get("/settings", async (c) => {
  const userId = c.get("userId");
  return c.json(await getWebSearchSettings(userId));
});

// PUT /api/v1/web-search/settings
app.put("/settings", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({})) as WebSearchSettingsInput;
  return c.json(await putWebSearchSettings(userId, body));
});

// POST /api/v1/web-search/test
app.post("/test", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({})) as {
    query?: string;
    settings?: WebSearchSettingsInput;
    apiKey?: string | null;
  };

  try {
    const stored = await getWebSearchSettings(userId);
    const hasInlineApiKey = typeof body.apiKey === "string" ? body.apiKey.trim().length > 0 : stored.hasApiKey;
    const merged = normalizeWebSearchSettings({ ...stored, ...(body.settings || {}) }, hasInlineApiKey);
    const effectiveApiKey = typeof body.apiKey === "string"
      ? (body.apiKey.trim() || null)
      : await getWebSearchApiKey(userId);

    const result = await searchWebWithConfig(body.query || "", undefined, merged, effectiveApiKey);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Web search test failed";
    return c.json({ error: message }, 400);
  }
});

export { app as webSearchRoutes };
