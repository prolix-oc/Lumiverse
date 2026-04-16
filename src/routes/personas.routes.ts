import { Hono } from "hono";
import * as svc from "../services/personas.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import { parsePagination } from "../services/pagination";
import { createAvatarResolverResponse } from "../utils/avatar-cache";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const app = new Hono();

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

  // Clean up images
  if (persona.image_id) images.deleteImage(userId, persona.image_id);
  if (persona.avatar_path) await files.deleteAvatar(persona.avatar_path);
  const origImageId = persona.metadata?.original_image_id;
  if (origImageId) images.deleteImage(userId, origImageId);

  const deleted = svc.deletePersona(userId, persona.id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const info = svc.getPersonaAvatarInfo(userId, c.req.param("id"));
  if (!info) return c.json({ error: "Not found" }, 404);

  const sizeParam = c.req.query("size") as images.ThumbTier | undefined;
  const tier = sizeParam === "sm" || sizeParam === "lg" ? sizeParam : undefined;

  if (info.image_id) {
    const filepath = await images.getImageFilePath(userId, info.image_id, tier);
    if (filepath) {
      return createAvatarResolverResponse(
        filepath,
        info.image_id + (tier ? `_${tier}` : ""),
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
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  // Clean up old image if present
  if (persona.image_id) images.deleteImage(userId, persona.image_id);
  if (persona.avatar_path) await files.deleteAvatar(persona.avatar_path);
  const oldOriginalImageId = persona.metadata?.original_image_id;
  if (oldOriginalImageId) images.deleteImage(userId, oldOriginalImageId);

  const image = await images.uploadImage(userId, file);
  svc.setPersonaImage(userId, persona.id, image.id);
  svc.setPersonaAvatar(userId, persona.id, image.filename);
  const updated = svc.getPersona(userId, persona.id);
  if (!updated) return c.json({ error: "Not found" }, 404);

  eventBus.emit(EventType.PERSONA_CHANGED, { id: persona.id, persona: updated }, userId);
  return c.json(updated);
});

export { app as personasRoutes };
