import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { transcodeVideo } from "../services/media.service";
import type { CapturedMediaRef, DesktopCaptureOptimizeRequest } from "./desktop-capture-contract";

export function validCaptureOptimization(input: DesktopCaptureOptimizeRequest): boolean {
  if (!input || typeof input !== "object" || typeof input.assetId !== "string" || !input.assetId
    || !Number.isInteger(input.maxEdge) || input.maxEdge < 256 || input.maxEdge > 3840) return false;
  if (input.kind === "image") return ["jpeg", "webp", "png"].includes(input.format)
    && Number.isInteger(input.quality) && input.quality >= 1 && input.quality <= 100;
  return input.kind === "video" && Number.isInteger(input.fps) && input.fps >= 1 && input.fps <= 30
    && Number.isInteger(input.bitrateKbps) && input.bitrateKbps >= 128 && input.bitrateKbps <= 8000;
}

export interface ProcessedCapture {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds?: number;
}

/** Reuses the media transcoder without exposing capture bytes or paths to workers. */
export async function processCaptureMedia(data: Buffer, ref: CapturedMediaRef,
  input: DesktopCaptureOptimizeRequest, signal: AbortSignal, maxBytes: number): Promise<ProcessedCapture> {
  signal.throwIfAborted();
  if (input.kind === "image") {
    let pipeline = sharp(data, { limitInputPixels: 16_777_216 }).resize({
      width: input.maxEdge, height: input.maxEdge, fit: "inside", withoutEnlargement: true,
    });
    if (input.format === "jpeg") pipeline = pipeline.flatten({ background: "white" }).jpeg({ quality: input.quality });
    else if (input.format === "webp") pipeline = pipeline.webp({ quality: input.quality });
    else pipeline = pipeline.png();
    const { data: output, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (signal.aborted || output.length > maxBytes) { output.fill(0); signal.throwIfAborted(); throw new Error("MEDIA_OUTPUT_TOO_LARGE"); }
    return { data: output, mimeType: `image/${input.format}`, width: info.width, height: info.height };
  }
  if (ref.width < 2 || ref.height < 2) throw new Error("INVALID_PROCESSED_CAPTURE");
  const scale = Math.min(1, input.maxEdge / Math.max(ref.width, ref.height));
  const width = Math.max(2, Math.floor(ref.width * scale / 2) * 2);
  const height = Math.max(2, Math.floor(ref.height * scale / 2) * 2);
  const directory = await mkdtemp(join(tmpdir(), "lumiverse-capture-"));
  try {
    const path = join(directory, ref.mimeType === "video/webm" ? "input.webm" : "input.mp4");
    await writeFile(path, data, { mode: 0o600 });
    signal.throwIfAborted();
    const result = await transcodeVideo({ path, mime_type: ref.mimeType }, {
      source: { kind: "inline", data, mime_type: ref.mimeType },
      output_format: "mp4", video_codec: "h264", audio_codec: "none",
      video_bitrate_kbps: input.bitrateKbps, width, height, fps: input.fps,
      preset: "veryfast", pixel_format: "yuv420p", faststart: true,
    }, { signal, maxOutputBytes: maxBytes, threads: 2 });
    const output = Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    const durationSeconds = (result.duration_ms ?? 0) / 1000;
    // Reject a truncated -fs output rather than silently dropping the end of the user's clip.
    if (result.width !== width || result.height !== height || durationSeconds <= 0
      || Math.abs(durationSeconds - (ref.durationSeconds ?? 0)) > Math.max(0.15, 1 / input.fps)) {
      output.fill(0);
      throw new Error("INVALID_PROCESSED_CAPTURE");
    }
    return { data: output, mimeType: "video/mp4", width, height, durationSeconds };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
