import { Hono } from "hono";
import * as svc from "../services/global-addons.service";
import { parsePagination } from "../services/pagination";

const app = new Hono();

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listGlobalAddons(userId, pagination));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  // M-32: The previous check (!body.label && body.label !== "") was confusing
  // and could pass non-string values (e.g. numbers) through.  Require label to
  // be a string explicitly.
  if (typeof body.label !== "string") return c.json({ error: "label is required and must be a string" }, 400);
  const addon = svc.createGlobalAddon(userId, body);
  return c.json(addon, 201);
});

app.put("/reorder", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!Array.isArray(body.ids)) return c.json({ error: "ids array is required" }, 400);
  svc.reorderGlobalAddons(userId, body.ids);
  return c.json({ success: true });
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const addon = svc.getGlobalAddon(userId, c.req.param("id"));
  if (!addon) return c.json({ error: "Not found" }, 404);
  return c.json(addon);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const addon = svc.updateGlobalAddon(userId, c.req.param("id"), body);
  if (!addon) return c.json({ error: "Not found" }, 404);
  return c.json(addon);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteGlobalAddon(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.post("/:id/duplicate", (c) => {
  const userId = c.get("userId");
  const addon = svc.duplicateGlobalAddon(userId, c.req.param("id"));
  if (!addon) return c.json({ error: "Not found" }, 404);
  return c.json(addon, 201);
});

export { app as globalAddonsRoutes };
