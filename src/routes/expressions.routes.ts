import { Hono } from "hono";
import * as svc from "../services/expressions.service";

const app = new Hono();

// GET / — get expression config for a character
app.get("/", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const config = svc.getExpressionConfig(userId, characterId);
  if (!config) return c.json({ error: "Character not found" }, 404);
  return c.json(config);
});

// PUT / — set/update full expression config
app.put("/", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const body = await c.req.json<svc.ExpressionConfig>();
  const config = svc.putExpressionConfig(userId, characterId, body);
  return c.json(config);
});

// POST /upload-zip — import expressions from a ZIP of named images
app.post("/upload-zip", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file is required" }, 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  const config = await svc.importFromZip(userId, characterId, buffer);
  return c.json(config, 201);
});

// POST /from-gallery — map gallery image IDs to expression labels
app.post("/from-gallery", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);

  const body = await c.req.json<{ mappings: Record<string, string> }>();
  if (!body.mappings || typeof body.mappings !== "object") {
    return c.json({ error: "mappings object is required" }, 400);
  }

  const config = svc.mapFromGallery(userId, characterId, body.mappings);
  return c.json(config);
});

// ── Multi-character expression groups ───────────────────────────────────────

// GET /groups — get expression groups for a character
app.get("/groups", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const groups = svc.getExpressionGroups(userId, characterId);
  return c.json(groups || {});
});

// POST /groups — create a new empty character group
app.post("/groups", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const body = await c.req.json<{ name: string }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  try {
    const groups = svc.addGroup(userId, characterId, body.name.trim());
    return c.json(groups, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// PUT /groups — replace full expression groups object
app.put("/groups", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const body = await c.req.json<Record<string, Record<string, string>>>();
  const groups = svc.putExpressionGroups(userId, characterId, body);
  return c.json(groups);
});

// POST /groups/convert-to-groups — switch from flat to multi-character mode
app.post("/groups/convert-to-groups", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  try {
    const groups = svc.convertToGroups(userId, characterId);
    return c.json(groups);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /groups/convert-to-flat — switch from multi-character back to flat mode
app.post("/groups/convert-to-flat", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const body = await c.req.json<{ groupName: string }>();
  if (!body.groupName) return c.json({ error: "groupName is required" }, 400);
  try {
    const config = svc.convertToFlat(userId, characterId, body.groupName);
    return c.json(config);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /groups/:groupName/labels — add a single expression to a group
app.post("/groups/:groupName/labels", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const groupName = decodeURIComponent(c.req.param("groupName"));
  const body = await c.req.json<{ label: string; imageId: string }>();
  if (!body.label || !body.imageId) return c.json({ error: "label and imageId are required" }, 400);
  try {
    const groups = svc.addGroupLabel(userId, characterId, groupName, body.label, body.imageId);
    return c.json(groups);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// POST /groups/:groupName/upload-zip — import ZIP of images into a group
app.post("/groups/:groupName/upload-zip", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const groupName = decodeURIComponent(c.req.param("groupName"));
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file is required" }, 400);
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const groups = await svc.importGroupFromZip(userId, characterId, groupName, buffer);
    return c.json(groups, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// DELETE /groups/:groupName — remove an entire character group
app.delete("/groups/:groupName", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const groupName = decodeURIComponent(c.req.param("groupName"));
  try {
    const groups = svc.removeGroup(userId, characterId, groupName);
    return c.json(groups);
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

// DELETE /groups/:groupName/:label — remove a label from a group
app.delete("/groups/:groupName/:label", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const groupName = decodeURIComponent(c.req.param("groupName"));
  const label = decodeURIComponent(c.req.param("label"));
  try {
    const groups = svc.removeGroupLabel(userId, characterId, groupName, label);
    return c.json(groups);
  } catch (err: any) {
    return c.json({ error: err.message }, 404);
  }
});

// DELETE /:label — remove a single expression mapping
app.delete("/:label", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);

  const label = c.req.param("label");
  if (!label) return c.json({ error: "label is required" }, 400);

  const config = svc.removeExpression(userId, characterId, decodeURIComponent(label));
  return c.json(config);
});

export { app as expressionsRoutes };
