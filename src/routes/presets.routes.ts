import { Hono } from "hono";
import * as svc from "../services/presets.service";
import { parsePagination } from "../services/pagination";

const app = new Hono();

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listPresets(userId, pagination));
});

app.get("/registry", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const provider = c.req.query("provider") || undefined;
  const engine = c.req.query("engine") || undefined;
  return c.json(svc.listPresetRegistry(userId, pagination, provider, engine));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) return c.json({ error: "name and provider are required" }, 400);
  return c.json(svc.createPreset(userId, body), 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const preset = svc.getPreset(userId, c.req.param("id"));
  if (!preset) return c.json({ error: "Not found" }, 404);
  return c.json(preset);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const preset = svc.updatePreset(userId, c.req.param("id"), body);
  if (!preset) return c.json({ error: "Not found" }, 404);
  return c.json(preset);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deletePreset(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as presetsRoutes };
