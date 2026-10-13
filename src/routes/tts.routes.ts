import { Hono } from "hono";
import * as ttsSvc from "../services/tts.service";
import { detectSpeechSegments } from "../services/speech-detection.service";
import * as audioSvc from "../services/audio.service";
import * as muxSvc from "../services/audio-mux.service";
import * as chatsSvc from "../services/chats.service";
import { clampErrorMessage, describeProviderError } from "../utils/provider-errors";
import { contentTypeForFormat } from "../utils/audio-content-type";
import type { TtsStreamChunk } from "../tts/types";

const app = new Hono();
const SSE_HEARTBEAT_MS = 5000;
const SSE_AUDIO_CHUNK_BYTES = 48 * 1024;

type StreamAudioPayload = {
  kind: "bytes" | "audio_file";
  mimeType: string;
  base64: string;
};

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (
    err.name === "AbortError" || /aborted|aborterror/i.test(err.message)
  );
}

function sseHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

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
      signal: c.req.raw.signal,
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

/** Synthesize speech with streaming — returns SSE-wrapped audio chunks */
app.post("/synthesize/stream", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  if (!body.text) {
    return c.json({ error: "text is required" }, 400);
  }

  const origin = c.req.header("origin") || "";
  const fallbackMimeType = contentTypeForFormat(body.outputFormat);
  const requestSignal = c.req.raw.signal;
  const streamInput = {
    connectionId: body.connectionId,
    text: body.text,
    voice: body.voice,
    model: body.model,
    parameters: body.parameters,
    outputFormat: body.outputFormat,
    signal: requestSignal,
  };

  let generator: AsyncGenerator<TtsStreamChunk, void, unknown> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const cleanup = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const sendComment = () => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`:\n\n`));
          return true;
        } catch {
          closed = true;
          cleanup();
          return false;
        }
      };

      const sendEvent = (event: string, data: unknown) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          closed = true;
          cleanup();
          return false;
        }
      };

      const emitAudioPayload = (payload: StreamAudioPayload) => sendEvent("audio", payload);

      const emitChunkedBytes = (
        kind: "bytes" | "audio_file",
        mimeType: string,
        data: Uint8Array,
      ) => {
        if (kind === "audio_file") {
          return emitAudioPayload({
            kind,
            mimeType,
            base64: Buffer.from(data).toString("base64"),
          });
        }

        for (let offset = 0; offset < data.byteLength; offset += SSE_AUDIO_CHUNK_BYTES) {
          const slice = data.subarray(offset, offset + SSE_AUDIO_CHUNK_BYTES);
          if (!emitAudioPayload({
            kind,
            mimeType,
            base64: Buffer.from(slice).toString("base64"),
          })) {
            return false;
          }
        }
        return true;
      };

      heartbeat = setInterval(() => {
        sendComment();
      }, SSE_HEARTBEAT_MS);

      void (async () => {
        let emittedAudio = false;

        const emitFallbackAudio = async () => {
          const result = await ttsSvc.synthesize(userId, streamInput);
          const data = new Uint8Array(result.audioData);
          if (data.byteLength === 0) return true;
          return emitChunkedBytes("bytes", result.contentType || fallbackMimeType, data);
        };

        try {
          try {
            generator = ttsSvc.synthesizeStream(userId, streamInput);
            for await (const chunk of generator) {
              if (closed || requestSignal.aborted) return;
              if (chunk.done || chunk.data.byteLength === 0) continue;
              const kind = chunk.kind || "bytes";
              const mimeType = chunk.mimeType || fallbackMimeType;
              emittedAudio = true;
              if (!emitChunkedBytes(kind, mimeType, chunk.data)) return;
            }
          } catch (streamErr) {
            if (closed || requestSignal.aborted || isAbortError(streamErr)) return;
            if (!emittedAudio) {
              try {
                if (!(await emitFallbackAudio()) || closed || requestSignal.aborted) return;
                sendEvent("done", { fallback: true });
                return;
              } catch (fallbackErr: any) {
                const msg = clampErrorMessage(describeProviderError(fallbackErr, "TTS streaming failed"));
                sendEvent("error", { error: msg });
                return;
              }
            }
            throw streamErr;
          }

          if (closed || requestSignal.aborted) return;
          sendEvent("done", { fallback: false });
        } catch (err: any) {
          if (closed || requestSignal.aborted || isAbortError(err)) return;
          const msg = clampErrorMessage(describeProviderError(err, "TTS streaming failed"));
          sendEvent("error", { error: msg });
        } finally {
          generator?.return(undefined as any).catch(() => {});
          close();
        }
      })();
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      generator?.return(undefined as any).catch(() => {});
    },
  });

  return new Response(stream, { headers: sseHeaders(origin) });
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
