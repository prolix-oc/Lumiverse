import { describe, expect, test } from "bun:test";
import { detectAudioFormat } from "./notification-sounds.service";

function pad(bytes: number[], length = 16): Uint8Array {
  const buf = new Uint8Array(length);
  buf.set(bytes);
  return buf;
}

describe("detectAudioFormat", () => {
  test("accepts ID3-tagged MP3", () => {
    const buf = pad([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectAudioFormat(buf)).toEqual({ mimeType: "audio/mpeg", extension: ".mp3" });
  });

  test("accepts raw MPEG audio frame sync", () => {
    // 0xFFFB = MPEG-1 Layer III
    const buf = pad([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectAudioFormat(buf)).toEqual({ mimeType: "audio/mpeg", extension: ".mp3" });
  });

  test("accepts ADTS AAC (MPEG-4 profile)", () => {
    const buf = pad([0xff, 0xf1, 0x50, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectAudioFormat(buf)).toEqual({ mimeType: "audio/aac", extension: ".aac" });
  });

  test("accepts RIFF/WAVE", () => {
    const buf = pad([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x24, 0x00, 0x00, 0x00, // size
      0x57, 0x41, 0x56, 0x45, // WAVE
    ]);
    expect(detectAudioFormat(buf)).toEqual({ mimeType: "audio/wav", extension: ".wav" });
  });

  test("accepts OggS", () => {
    const buf = pad([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectAudioFormat(buf)).toEqual({ mimeType: "audio/ogg", extension: ".ogg" });
  });

  test("accepts M4A (mp4 ftyp with M4A brand)", () => {
    const buf = pad([
      0x00, 0x00, 0x00, 0x20, // box size
      0x66, 0x74, 0x79, 0x70, // ftyp
      0x4d, 0x34, 0x41, 0x20, // M4A_
    ]);
    expect(detectAudioFormat(buf)).toEqual({ mimeType: "audio/mp4", extension: ".m4a" });
  });

  test("accepts ftyp mp42 brand", () => {
    const buf = pad([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70,
      0x6d, 0x70, 0x34, 0x32,
    ]);
    expect(detectAudioFormat(buf)).toEqual({ mimeType: "audio/mp4", extension: ".m4a" });
  });

  test("rejects HTML disguised as audio", () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html><body></body></html>");
    expect(detectAudioFormat(html)).toBeNull();
  });

  test("rejects PNG bytes", () => {
    const buf = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(detectAudioFormat(buf)).toBeNull();
  });

  test("rejects ZIP archive bytes", () => {
    const buf = pad([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectAudioFormat(buf)).toBeNull();
  });

  test("rejects ftyp with unknown brand", () => {
    const buf = pad([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70,
      0x71, 0x74, 0x20, 0x20, // qt__
    ]);
    expect(detectAudioFormat(buf)).toBeNull();
  });

  test("rejects buffers shorter than the header", () => {
    expect(detectAudioFormat(new Uint8Array([0x49, 0x44, 0x33]))).toBeNull();
  });

  test("rejects fake MPEG sync with reserved version bits", () => {
    // versionBits = 01 (reserved) → must reject
    const buf = pad([0xff, 0xea, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectAudioFormat(buf)).toBeNull();
  });
});
