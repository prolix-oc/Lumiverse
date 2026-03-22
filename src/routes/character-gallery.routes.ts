import { Hono } from "hono";
import * as svc from "../services/character-gallery.service";

const app = new Hono();

// GET / — list gallery items for a character
app.get("/", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const items = svc.listGallery(userId, characterId);
  return c.json(items);
});

// POST /bulk — upload multiple images to gallery in one request
app.post("/bulk", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const formData = await c.req.formData();

  const files = formData.getAll("images") as File[];
  if (!files.length) return c.json({ error: "images are required" }, 400);
  if (files.length > 100) return c.json({ error: "Maximum 100 images per request" }, 400);

  const items = await svc.uploadBulkToGallery(userId, characterId, files);
  return c.json(items, 201);
});

// POST / — upload image file + add to gallery
app.post("/", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const formData = await c.req.formData();

  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);

  const caption = (formData.get("caption") as string) || "";
  const item = await svc.uploadToGallery(userId, characterId, file, caption);
  return c.json(item, 201);
});

// POST /link — link an existing image to gallery
app.post("/link", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const body = await c.req.json<{ image_id: string; caption?: string }>();

  if (!body.image_id) return c.json({ error: "image_id is required" }, 400);

  const item = svc.addToGallery(userId, characterId, body.image_id, body.caption);
  return c.json(item, 201);
});

// POST /extract — scan character data for embedded images and import them
app.post("/extract", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const items = await svc.extractImagesFromCharacter(userId, characterId);
  return c.json(items, 201);
});

// DELETE /:itemId — remove gallery item
app.delete("/:itemId", (c) => {
  const userId = c.get("userId");
  const itemId = c.req.param("itemId");
  const deleted = svc.removeFromGallery(userId, itemId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// PATCH /:itemId — update caption
app.patch("/:itemId", async (c) => {
  const userId = c.get("userId");
  const itemId = c.req.param("itemId");
  const body = await c.req.json<{ caption: string }>();

  const item = svc.updateCaption(userId, itemId, body.caption);
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

export { app as characterGalleryRoutes };
