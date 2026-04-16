import { Hono } from "hono";
import * as ttsSvc from "../services/tts.service";
import { detectSpeechSegments } from "../services/speech-detection.service";

const app = new Hono();

/** Synthesize speech — returns audio binary */
app.post("/synthesize", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  if (!body.text) {
    return c.json({ error: "text is required" }, 400);
  }

  try {
    const result = await ttsSvc.synthesize(userId, {
      connectionId: body.connectionId,
      text: body.text,
      voice: body.voice,
      model: body.model,
      parameters: body.parameters,
      outputFormat: body.outputFormat,
    });

    return new Response(result.audioData, {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": "inline",
      },
    });
  } catch (err: any) {
    const status = /required|not found|unsupported|No API key|missing|connection|configured/i.test(err?.message) ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
});

/** Synthesize speech with streaming — returns chunked audio */
app.post("/synthesize/stream", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  if (!body.text) {
    return c.json({ error: "text is required" }, 400);
  }

  try {
    const generator = ttsSvc.synthesizeStream(userId, {
      connectionId: body.connectionId,
      text: body.text,
      voice: body.voice,
      model: body.model,
      parameters: body.parameters,
      outputFormat: body.outputFormat,
    });

    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await generator.next();
        if (done || value.done) {
          controller.close();
          return;
        }
        controller.enqueue(value.data);
      },
      cancel() {
        generator.return(undefined as any);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
        "Content-Disposition": "inline",
      },
    });
  } catch (err: any) {
    const status = /required|not found|unsupported|No API key|missing|connection|configured/i.test(err?.message) ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
});

/** Classify text into speech segments */
app.post("/detect-segments", async (c) => {
  const body = await c.req.json();

  if (!body.text) {
    return c.json({ error: "text is required" }, 400);
  }

  const segments = detectSpeechSegments(body.text, body.config);
  return c.json({ segments });
});

export { app as ttsRoutes };
