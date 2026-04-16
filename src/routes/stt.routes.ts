import { Hono } from "hono";
import * as sttSvc from "../services/stt.service";

const app = new Hono();

const MAX_STT_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB — well above any realistic recording

/** Transcribe audio via OpenAI STT */
app.post("/transcribe", async (c) => {
  const userId = c.get("userId");

  try {
    const formData = await c.req.formData();
    const file = formData.get("audio") as File | null;
    if (!file) {
      return c.json({ error: "audio file is required" }, 400);
    }
    if (typeof file.size === "number" && file.size > MAX_STT_AUDIO_BYTES) {
      return c.json({ error: "Audio file too large", maxBytes: MAX_STT_AUDIO_BYTES }, 413);
    }

    const audioData = await file.arrayBuffer();
    const language = formData.get("language") as string | null;
    const connectionId = formData.get("connectionId") as string | null;
    const model = formData.get("model") as string | null;

    const result = await sttSvc.transcribe(userId, {
      audioData,
      fileName: file.name || "recording.webm",
      model: model || undefined,
      language: language || undefined,
      connectionId: connectionId || undefined,
    });

    return c.json(result);
  } catch (err: any) {
    const status = /required|not found|No API key|connection|configured/i.test(err?.message) ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
});

export { app as sttRoutes };
