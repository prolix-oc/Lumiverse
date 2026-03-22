import { Hono } from "hono";
import * as files from "../services/files.service";

const app = new Hono();

app.post("/upload", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file is required" }, 400);

  const filename = await files.saveUpload(file, userId);
  return c.json({ filename }, 201);
});

app.get("/:filename", (c) => {
  const userId = c.get("userId");
  const filepath = files.getFilePath(userId, c.req.param("filename"));
  if (!filepath) return c.json({ error: "Not found" }, 404);
  const response = new Response(Bun.file(filepath));
  response.headers.set("Cache-Control", "public, max-age=3600");
  response.headers.set("Content-Disposition", "attachment");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
});

app.delete("/:filename", (c) => {
  const userId = c.get("userId");
  const deleted = files.deleteFile(userId, c.req.param("filename"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as filesRoutes };
