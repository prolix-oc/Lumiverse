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
