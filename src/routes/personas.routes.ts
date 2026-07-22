import { Hono } from "hono";
import * as svc from "../services/personas.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import { parsePagination } from "../services/pagination";
import { createAvatarResolverResponse } from "../utils/avatar-cache";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "../services/chats.service";
import {
  getChatPersonaAddonStates,
  getChatPersonaAddonToggleOrder,
  personaHasAddon,
} from "../services/persona-addon-states";

const app = new Hono();

function collectPersonaImageIds(persona: { image_id?: string | null; metadata?: Record<string, any> | null }): string[] {
  const ids = new Set<string>();
  if (persona.image_id) ids.add(persona.image_id);

  const cropImageId = typeof persona.metadata?.avatar_crop_image_id === "string"
    ? persona.metadata.avatar_crop_image_id
    : null;
  if (cropImageId) ids.add(cropImageId);

  const originalImageId = typeof persona.metadata?.original_image_id === "string"
    ? persona.metadata.original_image_id
    : null;
  if (originalImageId) ids.add(originalImageId);

  for (const addons of [persona.metadata?.addons, persona.metadata?.attached_global_addons]) {
    if (!Array.isArray(addons)) continue;
    for (const addon of addons) {
      if (typeof addon?.avatar_image_id === "string") ids.add(addon.avatar_image_id);
      if (typeof addon?.avatar_crop_image_id === "string") ids.add(addon.avatar_crop_image_id);
    }
  }

  return [...ids];
}

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listPersonas(userId, pagination));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const persona = svc.createPersona(userId, body);
  return c.json(persona, 201);
});

app.post("/folders/rename", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ old_name?: string; new_name?: string }>();
  const oldName = body.old_name?.trim() || "";
  const newName = body.new_name?.trim() || "";
  if (!oldName) return c.json({ error: "old_name is required" }, 400);
  if (!newName) return c.json({ error: "new_name is required" }, 400);

  const updated = svc.renamePersonaFolder(userId, oldName, newName);
  if (updated.length === 0) return c.json({ error: "Folder not found" }, 404);
  return c.json({ updated, count: updated.length });
});

app.post("/folders/delete", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim() || "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const updated = svc.deletePersonaFolder(userId, name);
  return c.json({ updated, count: updated.length });
});

app.post("/bulk-update", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    ids?: unknown;
    folder?: unknown;
    attached_world_book_id?: unknown;
    toggle_narrator?: unknown;
  }>();
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 1000) {
    return c.json({ error: "ids must be a non-empty array with at most 1000 items" }, 400);
  }
  const ids = body.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return c.json({ error: "ids must contain persona ids" }, 400);

  const input: svc.BulkPersonaUpdateInput = {};
  if (typeof body.folder === "string") input.folder = body.folder;
  if (body.attached_world_book_id === null || typeof body.attached_world_book_id === "string") {
    input.attached_world_book_id = body.attached_world_book_id;
  }
  if (body.toggle_narrator === true) input.toggle_narrator = true;
  if (Object.keys(input).length === 0) return c.json({ error: "No bulk update action supplied" }, 400);

  const updated = svc.bulkUpdatePersonas(userId, ids, input);
  return c.json({ updated, count: updated.length });
});

app.post("/bulk-delete", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 1000) {
    return c.json({ error: "ids must be a non-empty array with at most 1000 items" }, 400);
  }

  const ids = [...new Set(body.ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const personas = ids
    .map((id) => svc.getPersona(userId, id))
    .filter((persona): persona is NonNullable<typeof persona> => !!persona);
  const deleted: string[] = [];
  for (const persona of personas) {
    if (svc.deletePersona(userId, persona.id)) deleted.push(persona.id);
  }

  const imageIds = new Set(personas.flatMap(collectPersonaImageIds));
  for (const imageId of imageIds) images.deleteImageIfUnreferenced(userId, imageId);

  const avatarPaths = new Set(personas.map((persona) => persona.avatar_path).filter((path): path is string => !!path));
  for (const avatarPath of avatarPaths) {
    if (!svc.isPersonaAvatarPathReferenced(userId, avatarPath)) await files.deleteAvatar(avatarPath);
  }

  return c.json({ deleted, count: deleted.length });
});

app.post("/token-counts", async (c) => {
  const userId = c.get("userId");
  let body: { model_id?: unknown } = {};
  try {
    body = await c.req.json<{ model_id?: unknown }>();
  } catch {
    // An empty body is equivalent to omitting the optional model id.
  }
  if (body.model_id !== undefined && typeof body.model_id !== "string") {
    return c.json({ error: "model_id must be a string when provided" }, 400);
  }
  return c.json(await svc.getPersonaTokenCounts(userId, body.model_id || ""));
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const persona = svc.getPersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);
  return c.json(persona);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const persona = svc.updatePersona(userId, c.req.param("id"), body);
  if (!persona) return c.json({ error: "Not found" }, 404);
  return c.json(persona);
});

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const persona = svc.getPersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);

  const imageIds = collectPersonaImageIds(persona);

  const deleted = svc.deletePersona(userId, persona.id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  for (const imageId of imageIds) {
    images.deleteImageIfUnreferenced(userId, imageId);
  }
  if (persona.avatar_path) await files.deleteAvatar(persona.avatar_path);
  return c.json({ success: true });
});

app.get("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const personaId = c.req.param("id");
  const chatId = c.req.query("chat_id");
  let addonStates;
  let addonToggleOrder;
  if (chatId) {
    const chat = chats.getChat(userId, chatId);
    if (!chat) return c.json({ error: "Chat not found" }, 404);
    addonStates = getChatPersonaAddonStates(chat.metadata, personaId);
    addonToggleOrder = getChatPersonaAddonToggleOrder(chat.metadata, personaId);
  }
  const info = svc.getPersonaAvatarInfo(userId, personaId, { addonStates, addonToggleOrder });
  if (!info) return c.json({ error: "Not found" }, 404);

  const sizeParam = c.req.query("size") as images.ThumbTier | undefined;
  const tier = sizeParam === "sm" || sizeParam === "lg" ? sizeParam : undefined;
  // Avatar slots want the square crop, while lightboxes and themes that opt
  // into full-size artwork need the original upload. Keep crop-first as the
  // default so existing avatar URLs retain their current framing.
  const variant = c.req.query("variant") === "original" ? "original" : "crop";
  const imageIds = variant === "original"
    ? [info.image_id, info.avatar_crop_image_id]
    : [info.avatar_crop_image_id, info.image_id];

  for (const imageId of imageIds) {
    if (!imageId) continue;
    const filepath = await images.getImageFilePath(userId, imageId, tier);
    if (filepath) {
      return createAvatarResolverResponse(
        filepath,
        imageId + (tier ? `_${tier}` : ""),
        c.req.header("If-None-Match")
      );
    }
  }

  if (info.avatar_path) {
    const filepath = await files.getAvatarPath(info.avatar_path);
    if (filepath) {
      return createAvatarResolverResponse(
        filepath,
        info.avatar_path,
        c.req.header("If-None-Match")
      );
    }
  }

  return c.json({ error: "No avatar" }, 404);
});

/** Assign an already-uploaded image to an add-on's persona avatar override. */
app.put("/:id/addons/:addonId/avatar", async (c) => {
  const userId = c.get("userId");
  const persona = svc.getPersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);
  if (!personaHasAddon(persona, c.req.param("addonId"))) {
    return c.json({ error: "Add-on is not attached to this persona" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.image_id !== "string" || !body.image_id) {
    return c.json({ error: "image_id is required" }, 400);
  }
  if (!images.getImage(userId, body.image_id)) return c.json({ error: "Image not found" }, 404);
  if (body.avatar_crop_image_id !== undefined && body.avatar_crop_image_id !== null) {
    if (typeof body.avatar_crop_image_id !== "string" || !images.getImage(userId, body.avatar_crop_image_id)) {
      return c.json({ error: "Avatar crop image not found" }, 404);
    }
  }

  const oldImageIds = collectPersonaImageIds(persona);
  const updated = svc.setPersonaAddonAvatar(userId, persona.id, c.req.param("addonId"), {
    image_id: body.image_id,
    avatar_crop_image_id: typeof body.avatar_crop_image_id === "string" ? body.avatar_crop_image_id : null,
  });
  if (!updated) return c.json({ error: "Add-on is not attached to this persona" }, 404);
  for (const imageId of oldImageIds) images.deleteImageIfUnreferenced(userId, imageId);
  return c.json(updated);
});

/** Upload an alternative avatar for one add-on. `original_avatar` mirrors the
 * base-avatar crop flow: it preserves the source while `avatar` is displayed. */
app.post("/:id/addons/:addonId/avatar", async (c) => {
  const userId = c.get("userId");
  const persona = svc.getPersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);
  if (!personaHasAddon(persona, c.req.param("addonId"))) {
    return c.json({ error: "Add-on is not attached to this persona" }, 404);
  }

  const formData = await c.req.formData();
  const file = formData.get("avatar") as File | null;
  const originalFile = formData.get("original_avatar") as File | null;
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  const oldImageIds = collectPersonaImageIds(persona);
  const originalImage = await images.uploadImage(userId, originalFile ?? file);
  const cropImage = originalFile ? await images.uploadImage(userId, file) : null;
  const updated = svc.setPersonaAddonAvatar(userId, persona.id, c.req.param("addonId"), {
    image_id: originalImage.id,
    avatar_crop_image_id: cropImage?.id ?? null,
  });
  if (!updated) {
    images.deleteImageIfUnreferenced(userId, originalImage.id);
    if (cropImage) images.deleteImageIfUnreferenced(userId, cropImage.id);
    return c.json({ error: "Add-on is not attached to this persona" }, 404);
  }
  for (const imageId of oldImageIds) images.deleteImageIfUnreferenced(userId, imageId);
  return c.json(updated);
});

app.delete("/:id/addons/:addonId/avatar", (c) => {
  const userId = c.get("userId");
  const persona = svc.getPersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);
  if (!personaHasAddon(persona, c.req.param("addonId"))) {
    return c.json({ error: "Add-on is not attached to this persona" }, 404);
  }

  const oldImageIds = collectPersonaImageIds(persona);
  const updated = svc.setPersonaAddonAvatar(userId, persona.id, c.req.param("addonId"), { image_id: null });
  if (!updated) return c.json({ error: "Add-on is not attached to this persona" }, 404);
  for (const imageId of oldImageIds) images.deleteImageIfUnreferenced(userId, imageId);
  return c.json(updated);
});

app.post("/:id/duplicate", (c) => {
  const userId = c.get("userId");
  const persona = svc.duplicatePersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);
  return c.json(persona, 201);
});

app.post("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const persona = svc.getPersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("avatar") as File | null;
  const originalFile = formData.get("original_avatar") as File | null;
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  const oldImageIds = collectPersonaImageIds(persona);
  const originalImage = await images.uploadImage(userId, originalFile ?? file);
  const cropImage = originalFile ? await images.uploadImage(userId, file) : null;
  svc.setPersonaImage(userId, persona.id, originalImage.id);
  svc.setPersonaAvatar(userId, persona.id, originalImage.filename);

  const nextMetadata = { ...(persona.metadata ?? {}) };
  delete nextMetadata.original_image_id;
  if (cropImage) nextMetadata.avatar_crop_image_id = cropImage.id;
  else delete nextMetadata.avatar_crop_image_id;
  svc.updatePersona(userId, persona.id, { metadata: nextMetadata });
  for (const imageId of oldImageIds) {
    images.deleteImageIfUnreferenced(userId, imageId);
  }
  if (persona.avatar_path) await files.deleteAvatar(persona.avatar_path);

  const updated = svc.getPersona(userId, persona.id);
  if (!updated) return c.json({ error: "Not found" }, 404);

  eventBus.emit(EventType.PERSONA_CHANGED, { id: persona.id, persona: updated }, userId);
  return c.json(updated);
});

export { app as personasRoutes };
