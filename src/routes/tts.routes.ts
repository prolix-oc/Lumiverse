import { Hono } from "hono";
import * as ttsSvc from "../services/tts.service";
import { detectSpeechSegments } from "../services/speech-detection.service";
import * as audioSvc from "../services/audio.service";
import * as muxSvc from "../services/audio-mux.service";
import * as chatsSvc from "../services/chats.service";
import { clampErrorMessage, describeProviderError } from "../utils/provider-errors";
import { contentTypeForFormat } from "../utils/audio-content-type";

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
    const msg = clampErrorMessage(describeProviderError(err, "TTS synthesis failed"));
    const status = /required|not found|unsupported|No API key|missing|connection|configured/i.test(msg) ? 400 : 502;
    return c.json({ error: msg }, status);
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
        try {
          const { value, done } = await generator.next();
          if (done || value.done) {
            controller.close();
            return;
          }
          controller.enqueue(value.data);
        } catch {
          // Client disconnected mid-stream; abandon the generator quietly so
          // the AbortError doesn't bubble to app.onError as an opaque dump.
          generator.return(undefined as any).catch(() => {});
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        generator.return(undefined as any);
      },
    });

    // Derive from request so non-MP3 streams (Cartesia wav/raw, OpenRouter pcm) play in browsers.
    return new Response(stream, {
      headers: {
        "Content-Type": contentTypeForFormat(body.outputFormat),
        "Transfer-Encoding": "chunked",
        "Content-Disposition": "inline",
      },
    });
  } catch (err: any) {
    const msg = clampErrorMessage(describeProviderError(err, "TTS streaming failed"));
    const status = /required|not found|unsupported|No API key|missing|connection|configured/i.test(msg) ? 400 : 502;
    return c.json({ error: msg }, status);
  }
});

/**
 * Persist already-synthesized TTS audio onto a message swipe. Frontend uploads
 * the raw per-segment buffers it streamed during playback; we mux them into a
 * single MP3 (ffmpeg if available, naive concat fallback for MP3-only inputs)
 * and attach the result via chats.service.appendMessageAttachment.
 *
 * Audio is scoped per-swipe via the `swipe_id` field on the attachment. The
 * frontend captures the active swipe_id at synth start and passes it here, so
 * a mid-synth swipe by the user doesn't misroute the recording (the audio
 * always attaches to the swipe it was generated for). The "replace prior
 * audio" step only clobbers an existing recording for the SAME swipe_id;
 * other swipes' recordings are untouched.
 *
 * Legacy audio saved before the swipe_id field existed has no swipe_id and
 * is treated as "applies to all swipes" by the player — we don't clean it up
 * here either, even when saving for a specific swipe, so pre-existing
 * recordings survive until the user explicitly regenerates them.
 */
app.post("/save-message-audio", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();

  const chatId = formData.get("chatId");
  const messageId = formData.get("messageId");
  if (typeof chatId !== "string" || typeof messageId !== "string" || !chatId || !messageId) {
    return c.json({ error: "chatId and messageId are required" }, 400);
  }

  // Each `segment` field is a Blob/File for one TTS request response, in
  // playback order. FormData preserves repeated-field order across the wire.
  const segmentEntries = formData.getAll("segment");
  if (segmentEntries.length === 0) {
    return c.json({ error: "at least one segment is required" }, 400);
  }

  const segments: muxSvc.AudioSegment[] = [];
  for (const entry of segmentEntries) {
    if (!(entry instanceof Blob)) {
      return c.json({ error: "segment fields must be file blobs" }, 400);
    }
    const buf = Buffer.from(await entry.arrayBuffer());
    if (buf.byteLength === 0) {
      return c.json({ error: "segment file is empty" }, 400);
    }
    segments.push({ data: buf, mime_type: entry.type || "audio/mpeg" });
  }

  // Validate the message belongs to this user before doing any disk/mux work.
  const message = chatsSvc.getMessage(userId, messageId);
  if (!message || message.chat_id !== chatId) {
    return c.json({ error: "Message not found" }, 404);
  }

  // Resolve the target swipe. Prefer the explicit form value (frontend
  // captures this at synth start so it survives a mid-synth user swipe);
  // fall back to the message's current swipe_id when not provided.
  const rawSwipeId = formData.get("swipeId");
  let targetSwipeId: number;
  if (typeof rawSwipeId === "string" && rawSwipeId !== "") {
    const parsed = Number.parseInt(rawSwipeId, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return c.json({ error: "swipeId must be a non-negative integer" }, 400);
    }
    targetSwipeId = parsed;
  } else {
    targetSwipeId = message.swipe_id;
  }
  // Bound-check against the actual swipes array — the frontend snapshot
  // could be stale if a swipe got deleted between synth and save.
  if (targetSwipeId >= message.swipes.length) {
    return c.json({ error: "swipeId is out of range for this message" }, 400);
  }

  // Mux. May throw — surface as 500 with a clear hint when ffmpeg is missing
  // and a non-MP3 segment slipped through.
  let muxed: muxSvc.MuxResult;
  try {
    muxed = await muxSvc.muxSegments(segments);
  } catch (err: any) {
    return c.json({ error: err?.message || "audio mux failed" }, 500);
  }

  // Drop any prior audio attachment FOR THIS SWIPE. Other swipes'
  // recordings are untouched. Legacy audio without a swipe_id is also
  // left alone — interpreted as "applies to all swipes" so we don't
  // strand pre-existing recordings during the migration window.
  const existingExtra = (message.extra && typeof message.extra === "object" ? message.extra : {}) as Record<string, any>;
  const existingAttachments: any[] = Array.isArray(existingExtra.attachments) ? existingExtra.attachments : [];
  const priorAudio = existingAttachments.find(
    (a) => a && a.type === "audio" && a.swipe_id === targetSwipeId,
  );
  if (priorAudio?.image_id) {
    chatsSvc.removeMessageAttachment(userId, messageId, priorAudio.image_id);
  }

  // Persist the new audio file, then attach it.
  const filename = (typeof formData.get("filename") === "string" ? (formData.get("filename") as string) : "") || `tts-${messageId}-swipe-${targetSwipeId}.mp3`;
  const audioRow = await audioSvc.saveAudio(userId, {
    data: muxed.data,
    mime_type: muxed.mime_type,
    original_filename: filename,
  });

  const updated = chatsSvc.appendMessageAttachment(userId, messageId, {
    type: "audio",
    image_id: audioRow.id,
    mime_type: audioRow.mime_type,
    original_filename: audioRow.original_filename,
    swipe_id: targetSwipeId,
  });

  if (!updated) {
    // Race: message vanished between validation and append. Roll back the file.
    audioSvc.deleteAudio(userId, audioRow.id);
    return c.json({ error: "Message no longer exists" }, 404);
  }

  return c.json({ message: updated, audio: audioRow, muxed_with_ffmpeg: muxed.muxed_with_ffmpeg, swipe_id: targetSwipeId });
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
