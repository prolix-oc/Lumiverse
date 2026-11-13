import { Hono } from "hono";
import * as svc from "../services/notification-sounds.service";

const app = new Hono();

app.get("/completion", (c) => {
  const userId = c.get("userId");
  const stored = svc.getCompletionSound(userId);
  if (!stored) return c.json({ error: "Not found" }, 404);
  const response = new Response(Bun.file(stored.filepath));
  response.headers.set("Content-Type", stored.mimeType);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cache-Control", "private, max-age=3600");
  response.headers.set(
    "Content-Disposition",
    `inline; filename="${stored.filename}"`,
  );
  return response;
});

app.post("/completion", async (c) => {
  const userId = c.get("userId");
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data body" }, 400);
  }
  const file = formData.get("sound");
  if (!(file instanceof File)) {
    return c.json({ error: "Audio file is required" }, 400);
  }
  if (file.size > svc.MAX_NOTIFICATION_SOUND_BYTES) {
    return c.json(
      { error: "Audio file too large", maxBytes: svc.MAX_NOTIFICATION_SOUND_BYTES },
      413,
    );
  }
  try {
    const meta = await svc.setCompletionSound(userId, file);
    return c.json(meta, 201);
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to save sound" }, 400);
  }
});

app.delete("/completion", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteCompletionSound(userId);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as notificationSoundsRoutes };
