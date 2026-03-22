import { Hono } from "hono";
import * as councilSettingsSvc from "../services/council/council-settings.service";

const app = new Hono();

// GET /api/v1/council/settings
app.get("/settings", (c) => {
  const userId = c.get("userId");
  return c.json(councilSettingsSvc.getCouncilSettings(userId));
});

// PUT /api/v1/council/settings
app.put("/settings", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const updated = councilSettingsSvc.putCouncilSettings(userId, body);
  return c.json(updated);
});

// GET /api/v1/council/tools
app.get("/tools", (c) => {
  const userId = c.get("userId");
  const tools = councilSettingsSvc.getAvailableTools(userId);
  return c.json(tools);
});

export { app as councilRoutes };
