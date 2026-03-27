import { Hono } from "hono";
import * as svc from "../services/image-gen.service";

const app = new Hono();

app.get("/providers", (c) => {
  return c.json(svc.getImageProviders());
});

app.post("/generate", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.chatId) return c.json({ error: "chatId is required" }, 400);

  try {
    const result = await svc.generateSceneBackground(userId, body.chatId, {
      forceGeneration: !!body.forceGeneration,
    });
    return c.json(result);
  } catch (err: any) {
    const msg = String(err?.message || "Image generation failed");
    const status = /required|not found|unsupported|parse|No API key|missing|connection/i.test(msg) ? 400 : 502;
    return c.json({ error: msg }, status);
  }
});

export { app as imageGenRoutes };
