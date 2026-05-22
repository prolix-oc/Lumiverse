import { Hono } from "hono";
import * as svc from "../services/character-gallery.service";

const app = new Hono();

const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per image

function getGalleryFiles(formData: FormData): File[] {
  const parts = [...formData.getAll("images"), ...formData.getAll("image")];
  return parts.filter((part): part is File => part instanceof File && part.size > 0);
}

function partitionBySize(files: File[]): {
  valid: File[];
  oversized: svc.BulkGallerySkippedFile[];
} {
  const valid: File[] = [];
  const oversized: svc.BulkGallerySkippedFile[] = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      oversized.push({
        name: file.name || "unknown",
        reason: `exceeds ${MAX_IMAGE_UPLOAD_BYTES} byte cap (${file.size} bytes)`,
      });
    } else {
      valid.push(file);
    }
  }
  return { valid, oversized };
}

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

  const files = getGalleryFiles(formData);
  if (!files.length) return c.json({ error: "images are required" }, 400);
  if (files.length > 100) return c.json({ error: "Maximum 100 images per request" }, 400);

  const { valid, oversized } = partitionBySize(files);
  if (valid.length === 0) {
    return c.json(
      { error: "All files exceed the per-image size cap", maxBytes: MAX_IMAGE_UPLOAD_BYTES, skipped: oversized },
      413,
    );
  }

  const result = await svc.uploadBulkToGallery(userId, characterId, valid, oversized);
  return c.json(result, 201);
});

// POST / — upload image file + add to gallery
app.post("/", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  const formData = await c.req.formData();

  const file = getGalleryFiles(formData)[0] ?? null;
  if (!file) return c.json({ error: "image file is required" }, 400);
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return c.json({ error: "Image too large", maxBytes: MAX_IMAGE_UPLOAD_BYTES }, 413);
  }

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
