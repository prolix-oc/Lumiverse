import { Hono } from "hono";
import * as svc from "../services/images.service";

const app = new Hono();

app.post("/", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);

  const image = await svc.uploadImage(userId, file);
  return c.json(image, 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const thumb = c.req.query("thumb") === "true";

  const filepath = svc.getImageFilePath(userId, id, thumb);
  if (!filepath) return c.json({ error: "Not found" }, 404);

  const response = new Response(Bun.file(filepath));
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return response;
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteImage(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as imagesRoutes };
