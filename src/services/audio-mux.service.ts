import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface AudioSegment {
  data: Uint8Array | Buffer;
  mime_type: string;
}

export interface MuxResult {
  data: Buffer;
  mime_type: string;
  /** True when ffmpeg was used; false when we fell back to naive byte-concat. */
  muxed_with_ffmpeg: boolean;
}

let ffmpegAvailability: boolean | null = null;

/**
 * Check whether `ffmpeg` is present on PATH. Cached after the first call so
 * subsequent muxes don't re-spawn a probe per request. Force re-detection by
 * calling `resetFfmpegProbe()` (used in tests).
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailability !== null) return ffmpegAvailability;
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    ffmpegAvailability = code === 0;
  } catch {
    ffmpegAvailability = false;
  }
  return ffmpegAvailability;
}

export function resetFfmpegProbe(): void {
  ffmpegAvailability = null;
}

function extForMime(mime: string): string {
  switch ((mime || "").toLowerCase()) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/ogg":
    case "audio/ogg; codecs=opus":
    case "audio/opus":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "audio/aac":
      return "aac";
    case "audio/flac":
      return "flac";
    default:
      return "bin";
  }
}

function isMp3Mime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return m === "audio/mpeg" || m === "audio/mp3";
}

// ── MP3 frame-aware concatenation (the ffmpeg-less fallback) ────────────────
//
// A provider MP3 (OpenAI, ElevenLabs, …) is laid out as:
//
//   [ID3v2 tag?] [Xing/Info header frame] [audio frame] [audio frame] … [ID3v1?]
//
// The Xing/Info header frame is a silent MP3 frame whose payload declares the
// *frame count of that file*. Players (and the browser <audio> element) read
// it to learn the total duration up front.
//
// If we blindly byte-concatenate N provider MP3s, the browser reads the FIRST
// segment's Xing header, concludes the whole file is only as long as segment
// one, fires `ended` at that point, and refuses to play past it — even though
// every later segment's bytes are sitting right there in the file. That is the
// "saved TTS audio cuts off at ~50s" bug: ~50s is just the length of the first
// synthesized chunk.
//
// (The in-memory Web Audio engine never hit this because decodeAudioData
// decodes every frame it's handed and ignores the container's duration claim.)
//
// The fix: strip each segment down to its raw audio frames (dropping ID3 tags
// and the per-segment Xing/Info/VBRI header frame), concatenate those, then
// prepend a single fresh Xing header describing the FULL stream. The <audio>
// element now learns the correct total duration and can seek across the join.

const MPEG_V25 = 0;
const MPEG_RESERVED = 1;
const MPEG_V2 = 2;
const MPEG_V1 = 3;

// Layer III bitrate tables (kbps), indexed by the 4-bit bitrate field. Index 0
// is "free format" and 15 is "bad" — both unusable for frame sizing.
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1];
const SAMPLE_RATES: Record<number, number[]> = {
  [MPEG_V1]: [44100, 48000, 32000, -1],
  [MPEG_V2]: [22050, 24000, 16000, -1],
  [MPEG_V25]: [11025, 12000, 8000, -1],
};

interface FrameHeader {
  version: number; // MPEG_V1 | MPEG_V2 | MPEG_V25
  sampleRate: number; // Hz
  channelMode: number; // 3 = mono, else stereo/joint/dual
  frameLength: number; // total frame size in bytes, including the 4-byte header
  samplesPerFrame: number; // 1152 (MPEG1) or 576 (MPEG2/2.5) for Layer III
}

function toBuffer(data: Uint8Array | Buffer): Buffer {
  return data instanceof Buffer ? data : Buffer.from(data);
}

/**
 * Parse a Layer III MP3 frame header at `off`. Returns null when the bytes
 * aren't a valid Layer III frame sync (so callers can resync or stop walking).
 */
export function parseFrameHeader(buf: Buffer, off: number): FrameHeader | null {
  if (off + 4 > buf.length) return null;
  const b1 = buf[off]!;
  const b2 = buf[off + 1]!;
  const b3 = buf[off + 2]!;
  const b4 = buf[off + 3]!;
  // Frame sync: 11 set bits.
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;

  const version = (b2 >> 3) & 0x03;
  const layer = (b2 >> 1) & 0x03;
  if (version === MPEG_RESERVED) return null;
  if (layer !== 0x01) return null; // 0b01 == Layer III; we only handle MP3.

  const bitrateIndex = (b3 >> 4) & 0x0f;
  const sampleRateIndex = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;
  const channelMode = (b4 >> 6) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null; // free/bad
  if (sampleRateIndex === 0x03) return null; // reserved

  const isV1 = version === MPEG_V1;
  const bitrateKbps = (isV1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version]![sampleRateIndex]!;
  const samplesPerFrame = isV1 ? 1152 : 576;
  // Layer III frame size: (samples/8) * bitrate / sampleRate, plus a padding byte.
  const frameLength = Math.floor((samplesPerFrame / 8) * (bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLength < 4) return null;

  return { version, sampleRate, channelMode, frameLength, samplesPerFrame };
}

/**
 * Byte offset of the Xing/Info tag within a frame, which sits immediately after
 * the side-information block. Side-info size depends on MPEG version + channel
 * count (mono is smaller).
 */
export function sideInfoSize(h: FrameHeader): number {
  const mono = h.channelMode === 0x03;
  if (h.version === MPEG_V1) return mono ? 17 : 32;
  return mono ? 9 : 17;
}

/** True when the frame at `off` is a Xing / Info / VBRI metadata header frame. */
function frameIsVbrHeader(buf: Buffer, off: number, h: FrameHeader): boolean {
  const xingOff = off + 4 + sideInfoSize(h);
  if (xingOff + 4 <= buf.length) {
    const tag = buf.toString("latin1", xingOff, xingOff + 4);
    if (tag === "Xing" || tag === "Info") return true;
  }
  // VBRI (Fraunhofer encoders) always sits 32 bytes past the frame header.
  const vbriOff = off + 4 + 32;
  if (vbriOff + 4 <= buf.length && buf.toString("latin1", vbriOff, vbriOff + 4) === "VBRI") return true;
  return false;
}

/** Strip a leading ID3v2 tag if present (returns a subarray, no copy). */
function stripId3v2(buf: Buffer): Buffer {
  if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "ID3") return buf;
  const flags = buf[5]!;
  // Tag size is a 28-bit "sync-safe" integer (top bit of each byte is zero).
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const footer = (flags & 0x10) !== 0 ? 10 : 0; // optional 10-byte footer
  const end = 10 + size + footer;
  return end <= buf.length ? buf.subarray(end) : buf;
}

/** Strip a trailing 128-byte ID3v1 tag if present. */
function stripId3v1(buf: Buffer): Buffer {
  if (buf.length >= 128 && buf.toString("latin1", buf.length - 128, buf.length - 125) === "TAG") {
    return buf.subarray(0, buf.length - 128);
  }
  return buf;
}

/** Index of the first parseable Layer III frame sync at or after `from`, or -1. */
function indexOfFrameSync(buf: Buffer, from: number): number {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1]! & 0xe0) === 0xe0 && parseFrameHeader(buf, i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Reduce one provider MP3 to its raw audio frames: drop any ID3v2/ID3v1 tags
 * and the leading Xing/Info/VBRI header frame. Returns the original buffer
 * untouched when no frame sync is found (let the join degrade rather than throw).
 */
function extractAudioFrames(raw: Buffer): Buffer {
  let buf = stripId3v1(stripId3v2(raw));
  const start = indexOfFrameSync(buf, 0);
  if (start < 0) return buf;
  buf = buf.subarray(start);
  const first = parseFrameHeader(buf, 0);
  if (first && frameIsVbrHeader(buf, 0, first)) {
    return buf.subarray(first.frameLength); // drop the metadata header frame
  }
  return buf;
}

/**
 * Walk the joined audio frames to count them (needed for an accurate Xing
 * duration) and detect whether the stream is constant-bitrate. `clean` is false
 * if we hit bytes that aren't a frame mid-stream — in that case the caller skips
 * writing a Xing header rather than risk an incorrect duration.
 */
function walkFrames(buf: Buffer): { count: number; clean: boolean; cbr: boolean } {
  let off = 0;
  let count = 0;
  let firstLen = -1;
  let cbr = true;
  while (off + 4 <= buf.length) {
    const h = parseFrameHeader(buf, off);
    if (!h) return { count, clean: false, cbr };
    if (firstLen < 0) firstLen = h.frameLength;
    else if (h.frameLength !== firstLen) cbr = false;
    count++;
    off += h.frameLength;
  }
  // A sub-4-byte tail (or a final frame whose declared length overran the
  // buffer) is a clean enough end for duration purposes.
  return { count, clean: true, cbr };
}

/**
 * Build a single Xing/Info header frame describing a stream of `frameCount`
 * audio frames totalling `byteCount` bytes. The frame reuses the first real
 * frame's 4 header bytes so its MPEG version / sample rate / channel layout
 * match, and is sized to that frame so it's a valid (silent) frame for any
 * decoder that doesn't special-case the tag.
 */
function buildXingHeaderFrame(
  template: FrameHeader,
  header4: Buffer,
  frameCount: number,
  byteCount: number,
  cbr: boolean,
): Buffer {
  const frame = Buffer.alloc(template.frameLength);
  header4.copy(frame, 0, 0, 4);
  const tagOff = 4 + sideInfoSize(template);
  // "Info" by convention marks CBR, "Xing" marks VBR — players treat both the
  // same for duration, so the distinction is purely cosmetic.
  frame.write(cbr ? "Info" : "Xing", tagOff, "latin1");
  frame.writeUInt32BE(0x0003, tagOff + 4); // flags: frames(0x1) + bytes(0x2)
  frame.writeUInt32BE(frameCount >>> 0, tagOff + 8);
  frame.writeUInt32BE(byteCount >>> 0, tagOff + 12);
  return frame;
}

/**
 * Join MP3 segments without ffmpeg by stitching their raw audio frames and
 * prepending one accurate Xing header for the combined stream (see the block
 * comment above for why naive byte-concat truncates playback). Errors loudly on
 * non-MP3 inputs — heterogeneous formats still need ffmpeg.
 */
export function naiveConcatMp3(segments: AudioSegment[]): Buffer {
  for (const seg of segments) {
    if (!isMp3Mime(seg.mime_type)) {
      throw new Error(
        `naive concat fallback only supports audio/mpeg segments; got ${seg.mime_type}. Install ffmpeg (Termux: pkg install ffmpeg) for multi-format support.`,
      );
    }
  }

  const audio = Buffer.concat(segments.map((s) => extractAudioFrames(toBuffer(s.data))));

  // Locate frame 1 of the joined stream so the Xing header can mirror it.
  const firstSync = indexOfFrameSync(audio, 0);
  if (firstSync < 0) return audio; // unparseable — ship the raw join, no worse than before
  const first = parseFrameHeader(audio, firstSync)!;
  const body = audio.subarray(firstSync);

  // Count frames for the duration field. If the walk isn't clean we still
  // return the (header-stripped) join: with no misleading Xing header the
  // browser estimates duration from the bitrate and plays the whole file,
  // which is the property we actually need — just with a less precise seekbar.
  const walk = walkFrames(body);
  if (!walk.clean || walk.count === 0) return body;

  const header = buildXingHeaderFrame(first, body.subarray(0, 4), walk.count, first.frameLength + body.length, walk.cbr);
  return Buffer.concat([header, body]);
}

/**
 * Quote a path for an ffmpeg concat-demuxer list file. The format expects
 * `file 'path'` with single quotes; literal single quotes inside the path
 * are escaped per ffmpeg's quoting rules (close, escaped backslash-quote,
 * reopen).
 */
function quoteConcatPath(p: string): string {
  return p.replace(/'/g, "'\\''");
}

async function runFfmpeg(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stderr };
}

async function muxWithFfmpeg(segments: AudioSegment[]): Promise<Buffer> {
  const workdir = mkdtempSync(join(tmpdir(), "tts-mux-"));
  try {
    const segmentPaths: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const ext = extForMime(seg.mime_type);
      const segPath = join(workdir, `seg_${i.toString().padStart(4, "0")}.${ext}`);
      const buf = seg.data instanceof Buffer ? seg.data : Buffer.from(seg.data);
      writeFileSync(segPath, buf);
      segmentPaths.push(segPath);
    }

    const listPath = join(workdir, "concat.txt");
    writeFileSync(
      listPath,
      segmentPaths.map((p) => `file '${quoteConcatPath(p)}'`).join("\n") + "\n",
    );

    const outPath = join(workdir, `out.mp3`);

    // First attempt: copy codec. Works when every segment is the same codec
    // and stream parameters. Avoids transcoding cost and quality loss.
    let result = await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-y",
      outPath,
    ]);

    if (!result.ok) {
      // Retry with re-encode to MP3 — handles codec/sample-rate mismatches
      // between providers (e.g. mixing OpenAI MP3 with ElevenLabs MP3 at a
      // different bitrate, or any non-MP3 input).
      result = await runFfmpeg([
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        "-ar", "44100",
        "-y",
        outPath,
      ]);
      if (!result.ok) {
        throw new Error(`ffmpeg mux failed: ${result.stderr.trim().slice(0, 500)}`);
      }
    }

    if (!existsSync(outPath)) {
      throw new Error("ffmpeg mux produced no output file");
    }

    const data = await Bun.file(outPath).bytes();
    return Buffer.from(data);
  } finally {
    // Force-remove the tmp dir even if a segment write or ffmpeg invocation
    // threw — leaving these around fills /tmp on long-running servers.
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/**
 * Combine N TTS segment buffers into a single playable audio file.
 *
 *   • 1 segment       → passthrough, no work.
 *   • N segments + ffmpeg present → concat demuxer with codec copy, then
 *     re-encode fallback on stream-parameter mismatch. Result is always MP3.
 *   • N segments + no ffmpeg → naive MP3 frame byte-concat (MP3-only). Throws
 *     loudly on non-MP3 mixes so the caller can degrade gracefully (e.g. fail
 *     persistence and keep playing the ephemeral segments).
 *
 * The result mime is `audio/mpeg` after a real mux even if some inputs were
 * other formats — we standardize on MP3 since it's the dominant TTS provider
 * output and Web Audio plays it everywhere.
 */
export async function muxSegments(segments: AudioSegment[]): Promise<MuxResult> {
  if (segments.length === 0) {
    throw new Error("muxSegments requires at least one segment");
  }
  if (segments.length === 1) {
    const seg = segments[0]!;
    return {
      data: seg.data instanceof Buffer ? seg.data : Buffer.from(seg.data),
      mime_type: seg.mime_type || "audio/mpeg",
      muxed_with_ffmpeg: false,
    };
  }

  const hasFfmpeg = await isFfmpegAvailable();
  if (hasFfmpeg) {
    const data = await muxWithFfmpeg(segments);
    return { data, mime_type: "audio/mpeg", muxed_with_ffmpeg: true };
  }

  const data = naiveConcatMp3(segments);
  return { data, mime_type: "audio/mpeg", muxed_with_ffmpeg: false };
}
