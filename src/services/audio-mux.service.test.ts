import { describe, expect, test } from "bun:test";
import { naiveConcatMp3, parseFrameHeader, sideInfoSize, type AudioSegment } from "./audio-mux.service";

// ── Synthetic MP3 fixtures ──────────────────────────────────────────────────
// We don't need real audio — the concat logic only reads frame headers and
// walks by frame length. Every frame below is a valid MPEG-1 Layer III,
// 128 kbps, 44.1 kHz, stereo frame (frame length 417, side info 32).

const FRAME_LEN = 417;
const SIDE_INFO = 32; // MPEG1 stereo
const XING_TAG_OFFSET = 4 + SIDE_INFO; // 36
const XING_FRAMES_FIELD = XING_TAG_OFFSET + 8; // tag(4) + flags(4)

/** A plain audio frame: valid header, silent payload, with a marker byte so we
 *  can prove the payload bytes survive the join in order. */
function audioFrame(marker: number): Buffer {
  const f = Buffer.alloc(FRAME_LEN);
  f[0] = 0xff;
  f[1] = 0xfb; // MPEG1, Layer III, no CRC
  f[2] = 0x90; // bitrate idx 9 (128k), samplerate idx 0 (44100), no padding
  f[3] = 0x00; // stereo
  f[10] = marker; // somewhere in the payload, clear of header + side info
  return f;
}

/** A Xing/Info header frame declaring `declaredFrames` — exactly what each
 *  provider MP3 carries and what naive byte-concat used to leak as the whole
 *  file's duration. */
function xingFrame(declaredFrames: number): Buffer {
  const f = audioFrame(0);
  f.write("Info", XING_TAG_OFFSET, "latin1");
  f.writeUInt32BE(0x0001, XING_TAG_OFFSET + 4); // flags: frames present
  f.writeUInt32BE(declaredFrames, XING_FRAMES_FIELD);
  return f;
}

function id3v2(payloadLen: number): Buffer {
  const t = Buffer.alloc(10 + payloadLen);
  t.write("ID3", 0, "latin1");
  t[3] = 3; // v2.3.0
  t[6] = (payloadLen >> 21) & 0x7f;
  t[7] = (payloadLen >> 14) & 0x7f;
  t[8] = (payloadLen >> 7) & 0x7f;
  t[9] = payloadLen & 0x7f;
  return t;
}

function id3v1(): Buffer {
  const t = Buffer.alloc(128);
  t.write("TAG", 0, "latin1");
  return t;
}

/** One provider MP3: optional ID3v2 + Xing header + `frameCount` audio frames. */
function providerMp3(frameCount: number, opts: { id3v2?: number; id3v1?: boolean; markerBase?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  if (opts.id3v2) parts.push(id3v2(opts.id3v2));
  parts.push(xingFrame(frameCount)); // declares THIS file's frame count
  for (let i = 0; i < frameCount; i++) parts.push(audioFrame((opts.markerBase ?? 1) + i));
  if (opts.id3v1) parts.push(id3v1());
  return Buffer.concat(parts);
}

function mp3Segment(buf: Buffer): AudioSegment {
  return { data: buf, mime_type: "audio/mpeg" };
}

/** Read the Xing frame-count field out of a concat result's first frame. */
function readXingFrameCount(out: Buffer): { tag: string; frames: number } {
  const h = parseFrameHeader(out, 0)!;
  const tagOff = 4 + sideInfoSize(h);
  return {
    tag: out.toString("latin1", tagOff, tagOff + 4),
    frames: out.readUInt32BE(tagOff + 8),
  };
}

/** Count real audio frames after the leading Xing header. */
function countAudioFramesAfterHeader(out: Buffer): number {
  let off = parseFrameHeader(out, 0)!.frameLength; // skip the Xing header frame
  let count = 0;
  while (off + 4 <= out.length) {
    const h = parseFrameHeader(out, off);
    if (!h) break;
    count++;
    off += h.frameLength;
  }
  return count;
}

describe("naiveConcatMp3 — duration-correct frame join", () => {
  test("prepends a Xing header counting ALL frames, not just segment one", () => {
    // The bug: blindly concatenating these two would surface segment one's
    // Xing header (3 frames) as the whole file's duration, truncating playback.
    const seg1 = providerMp3(3, { id3v2: 64, markerBase: 1 });
    const seg2 = providerMp3(5, { markerBase: 100 });

    const out = naiveConcatMp3([mp3Segment(seg1), mp3Segment(seg2)]);

    const { tag, frames } = readXingFrameCount(out);
    expect(tag).toBe("Info"); // all frames identical length → CBR
    expect(frames).toBe(8); // 3 + 5, the true total — NOT 3
    expect(countAudioFramesAfterHeader(out)).toBe(8);
    // One rebuilt Xing header + 8 audio frames, no leaked per-segment headers.
    expect(out.length).toBe(FRAME_LEN * (1 + 8));
  });

  test("preserves audio frame bytes in playback order across the join", () => {
    const seg1 = providerMp3(2, { markerBase: 11 });
    const seg2 = providerMp3(2, { markerBase: 21 });

    const out = naiveConcatMp3([mp3Segment(seg1), mp3Segment(seg2)]);

    // Walk frames after the rebuilt header and collect markers.
    let off = parseFrameHeader(out, 0)!.frameLength;
    const markers: number[] = [];
    while (off + 4 <= out.length) {
      const h = parseFrameHeader(out, off);
      if (!h) break;
      markers.push(out[off + 10]!);
      off += h.frameLength;
    }
    expect(markers).toEqual([11, 12, 21, 22]);
  });

  test("strips trailing ID3v1 tags so they don't corrupt the frame walk", () => {
    const seg1 = providerMp3(3, { id3v1: true, markerBase: 1 });
    const seg2 = providerMp3(4, { id3v1: true, markerBase: 50 });

    const out = naiveConcatMp3([mp3Segment(seg1), mp3Segment(seg2)]);

    expect(readXingFrameCount(out).frames).toBe(7);
    expect(out.length).toBe(FRAME_LEN * (1 + 7)); // no stray 128-byte TAG blocks
  });

  test("handles segments that have no Xing header of their own", () => {
    // Some providers emit bare frame streams with no VBR header.
    const bare = (n: number, base: number) => Buffer.concat(Array.from({ length: n }, (_, i) => audioFrame(base + i)));
    const out = naiveConcatMp3([mp3Segment(bare(4, 1)), mp3Segment(bare(2, 90))]);
    expect(readXingFrameCount(out).frames).toBe(6);
    expect(countAudioFramesAfterHeader(out)).toBe(6);
  });

  test("still rejects non-MP3 segments (those need ffmpeg)", () => {
    expect(() =>
      naiveConcatMp3([mp3Segment(providerMp3(2)), { data: Buffer.from([1, 2, 3]), mime_type: "audio/wav" }]),
    ).toThrow(/only supports audio\/mpeg/);
  });
});
