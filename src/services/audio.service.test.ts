import { describe, expect, test } from "bun:test";
import { normalizeSupportedAudioMimeType } from "./audio.service";

describe("normalizeSupportedAudioMimeType", () => {
  test.each([
    ["audio/mpeg", "clip.mp3", "audio/mp3"],
    ["audio/x-wav", "clip.wav", "audio/wav"],
    ["audio/x-aiff", "clip.aiff", "audio/aiff"],
    ["", "clip.flac", "audio/flac"],
  ])("normalizes %s (%s) to %s", (mimeType, filename, expected) => {
    expect(normalizeSupportedAudioMimeType(mimeType, filename)).toBe(expected);
  });

  test("rejects formats outside Gemini's documented audio set", () => {
    expect(normalizeSupportedAudioMimeType("audio/mp4", "clip.m4a")).toBeNull();
  });
});
