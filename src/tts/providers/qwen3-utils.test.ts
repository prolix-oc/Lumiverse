import { describe, expect, test } from "bun:test";
import {
  mergeQwenVoiceOptions,
  parseQwenVoice,
  qwenPromptVoiceId,
  qwenSpeakerVoiceId,
  readQwenCustomVoices,
  writeQwenCustomVoices,
} from "./qwen3-utils";

describe("parseQwenVoice", () => {
  test("parses prefixed prompt ids", () => {
    expect(parseQwenVoice("prompt:abc-123")).toEqual({ kind: "prompt", promptId: "abc-123" });
  });

  test("treats unprefixed values as built-in speakers", () => {
    expect(parseQwenVoice("Ryan")).toEqual({ kind: "speaker", speaker: "Ryan" });
  });
});

describe("Qwen custom voice metadata", () => {
  test("round-trips saved custom voices in connection metadata", () => {
    const metadata = writeQwenCustomVoices({}, [
      {
        id: qwenPromptVoiceId("prompt-1"),
        name: "Noir Narrator",
        prompt_id: "prompt-1",
        transcript: "hello there",
        source_filename: "sample.wav",
        created_at: 123,
      },
    ]);

    expect(readQwenCustomVoices(metadata)).toEqual([
      {
        id: qwenPromptVoiceId("prompt-1"),
        name: "Noir Narrator",
        prompt_id: "prompt-1",
        transcript: "hello there",
        source_filename: "sample.wav",
        created_at: 123,
      },
    ]);
  });

  test("merges saved clone voices ahead of built-in speakers without duplicates", () => {
    const merged = mergeQwenVoiceOptions(
      [
        { id: qwenSpeakerVoiceId("Ryan"), name: "Ryan", language: "English" },
        { id: qwenPromptVoiceId("prompt-1"), name: "Old Label" },
      ],
      writeQwenCustomVoices({}, [
        {
          id: qwenPromptVoiceId("prompt-1"),
          name: "Noir Narrator",
          prompt_id: "prompt-1",
          created_at: 1,
        },
      ]),
    );

    expect(merged).toEqual([
      { id: qwenPromptVoiceId("prompt-1"), name: "Noir Narrator", language: undefined },
      { id: qwenSpeakerVoiceId("Ryan"), name: "Ryan", language: "English" },
    ]);
  });
});
