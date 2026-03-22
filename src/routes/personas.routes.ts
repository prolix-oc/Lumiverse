import { Hono } from "hono";
import * as svc from "../services/personas.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import { parsePagination } from "../services/pagination";

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

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deletePersona(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/avatar", (c) => {
  const userId = c.get("userId");
  const persona = svc.getPersona(userId, c.req.param("id"));
  if (!persona) return c.json({ error: "Not found" }, 404);

  if (persona.image_id) {
    const filepath = images.getImageFilePath(userId, persona.image_id);
    if (filepath) {
      const response = new Response(Bun.file(filepath));
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return response;
    }
  }

  if (persona.avatar_path) {
    const filepath = files.getAvatarPath(persona.avatar_path);
    if (filepath) {
      const response = new Response(Bun.file(filepath));
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return response;
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
  if (persona.avatar_path) files.deleteAvatar(persona.avatar_path);

  const image = await images.uploadImage(userId, file);
  svc.setPersonaImage(userId, persona.id, image.id);
  svc.setPersonaAvatar(userId, persona.id, image.filename);
  return c.json({ image_id: image.id, avatar_path: image.filename });
});

export { app as personasRoutes };
