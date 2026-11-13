import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterTtsProvider } from "./openrouter-tts";
import { DEFAULT_GEMINI_TTS_SPEECH_STYLE } from "./google-tts-shared";
import type { TtsRequest, TtsStreamChunk } from "../types";

const originalFetch = globalThis.fetch;
const provider = new OpenRouterTtsProvider();
const pcm = new Uint8Array([0, 0, 128, 0, 255, 127, 0, 128]);
const geminiRequest: TtsRequest = {
  text: "Hello", model: "google/gemini-3.8-flash-tts", voice: "Kore", parameters: {},
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenRouter TTS PCM output", () => {
  test.each([
    { model: "google/gemini-3.8-flash-tts", parameters: {}, expected: DEFAULT_GEMINI_TTS_SPEECH_STYLE },
    { model: "google/gemini-3.8-flash-lite-tts", parameters: {}, expected: DEFAULT_GEMINI_TTS_SPEECH_STYLE },
    { model: "google/gemini-3.8-flash-tts", parameters: { speech_style: "  soft, conversational  " }, expected: "soft, conversational" },
    { model: "google/gemini-3.8-flash-tts", parameters: { speech_style: "", instructions: "ignored fallback" }, expected: undefined },
    { model: "google/gemini-3.1-flash-tts-preview", parameters: {}, expected: undefined },
    { model: "microsoft/mai-voice-2", parameters: { speech_style: "conversational" }, expected: undefined },
    { model: "openai/gpt-4o-mini-tts", parameters: { instructions: "Speak softly" }, expected: "Speak softly" },
  ])("uses model-appropriate instructions while preserving the transcript (%j)", async ({ model, parameters, expected }) => {
    let body: Record<string, any> = {};
    (globalThis as any).fetch = async (_input: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(pcm, { headers: { "Content-Type": "audio/pcm;rate=24000" } });
    };
    const text = "Before <giggle> after.";
    await provider.synthesize("key", "", { ...geminiRequest, model, text, parameters });
    expect(body.input).toBe(text);
    expect(body.instructions).toBe(expected);
    expect(body).not.toHaveProperty("speech_metadata");
    if (expected === undefined) expect(body).not.toHaveProperty("instructions");
  });

  test.each([
    "google/gemini-2.5-flash-tts",
    "google/gemini-3.8-flash-tts",
    "google/gemini-3.8-flash-lite-tts",
  ])("requests PCM instead of a configured MP3 format for %s", async (model) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(pcm, { headers: { "Content-Type": "audio/pcm;rate=24000;channels=1" } });
    };
    const controller = new AbortController();
    const result = await provider.synthesize("key", "", {
      ...geminiRequest, model, outputFormat: "mp3", signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(calls[0].init?.signal).toBe(controller.signal);
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer key");
    expect(new Headers(calls[0].init?.headers).get("HTTP-Referer")).toBe("https://lumiverse.chat");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model, input: "Hello", voice: "Kore", response_format: "pcm",
    });
    expect(result.contentType).toBe("audio/wav");
    expect(result.model).toBe(model);
    expect(result.provider).toBe("openrouter_tts");
    expect(Buffer.from(result.audioData.slice(0, 4)).toString()).toBe("RIFF");
    expect(new Uint8Array(result.audioData.slice(44))).toEqual(pcm);
    expect(new DataView(result.audioData).getUint32(40, true)).toBe(pcm.length);
  });

  test.each(["audio/pcm", undefined])("uses Gemini PCM defaults without format metadata (%s)", async (contentType) => {
    (globalThis as any).fetch = async () => new Response(pcm, {
      headers: contentType ? { "Content-Type": contentType } : {},
    });

    const result = await provider.synthesize("key", "", geminiRequest);
    const header = new DataView(result.audioData);
    expect(result.contentType).toBe("audio/wav");
    expect(header.getUint32(24, true)).toBe(24000);
    expect(header.getUint16(22, true)).toBe(1);
    expect(header.getUint16(34, true)).toBe(16);
    expect(new Uint8Array(result.audioData.slice(44))).toEqual(pcm);
  });

  test("wraps explicitly requested PCM using the response sample rate and channels", async () => {
    let body: Record<string, any> = {};
    (globalThis as any).fetch = async (_input: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(pcm, { headers: { "Content-Type": "audio/pcm;rate=48000;channels=2" } });
    };

    const result = await provider.synthesize("key", "", {
      ...geminiRequest, model: "microsoft/mai-voice-2", voice: "en-US-Harper:MAI-Voice-2", outputFormat: "pcm",
    });
    const header = new DataView(result.audioData);
    expect(body.response_format).toBe("pcm");
    expect(result.contentType).toBe("audio/wav");
    expect(header.getUint16(22, true)).toBe(2);
    expect(header.getUint32(24, true)).toBe(48000);
    expect(header.getUint32(28, true)).toBe(192000);
    expect(header.getUint16(32, true)).toBe(4);
    expect(new Uint8Array(result.audioData.slice(44))).toEqual(pcm);
  });

  test.each([
    { model: "microsoft/mai-voice-2", voice: "en-US-Harper:MAI-Voice-2" },
    { model: "mistralai/voxtral-mini-tts-2603", voice: "en_paul_neutral" },
  ])("preserves MP3 as the default for other models (%j)", async (settings) => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    let body: Record<string, any> = {};
    (globalThis as any).fetch = async (_input: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
    };

    const result = await provider.synthesize("key", "", { ...geminiRequest, ...settings });
    expect(body.response_format).toBe("mp3");
    expect(result.contentType).toBe("audio/mpeg");
    expect(new Uint8Array(result.audioData)).toEqual(audio);
  });

  test("combines streamed PCM before adding one WAV header, including odd-byte boundaries", async () => {
    let body: Record<string, any> = {};
    (globalThis as any).fetch = async (_input: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(pcm.slice(0, 3));
          controller.enqueue(pcm.slice(3));
          controller.close();
        },
      }), { headers: { "Content-Type": "audio/pcm;rate=16000;channels=1" } });
    };

    const chunks: TtsStreamChunk[] = [];
    for await (const chunk of provider.synthesizeStream("key", "", geminiRequest)) chunks.push(chunk);

    expect(body.response_format).toBe("pcm");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].kind).toBe("audio_file");
    expect(chunks[0].mimeType).toBe("audio/wav");
    expect(chunks[0].done).toBe(false);
    expect(chunks[0].data.length).toBe(44 + pcm.length);
    expect(new DataView(chunks[0].data.buffer).getUint32(24, true)).toBe(16000);
    expect(chunks[0].data.slice(44)).toEqual(pcm);
    expect(chunks[1].done).toBe(true);
    expect(chunks[1].data.byteLength).toBe(0);
    expect(chunks[1].mimeType).toBe("audio/wav");
  });

  test("keeps MP3 streaming as a byte stream", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    (globalThis as any).fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(audio.slice(0, 2));
        controller.enqueue(audio.slice(2));
        controller.close();
      },
    }), { headers: { "Content-Type": "audio/mpeg" } });

    const chunks: TtsStreamChunk[] = [];
    for await (const chunk of provider.synthesizeStream("key", "", {
      ...geminiRequest, model: "microsoft/mai-voice-2", voice: "en-US-Harper:MAI-Voice-2",
    })) chunks.push(chunk);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].kind).toBe("bytes");
    expect(chunks[0].mimeType).toBe("audio/mpeg");
    expect(chunks[0].data).toEqual(audio.slice(0, 2));
    expect(chunks[1].data).toEqual(audio.slice(2));
    expect(chunks[2].done).toBe(true);
  });

  test("does not wrap provider error responses as PCM audio", async () => {
    (globalThis as any).fetch = async () => new Response("invalid voice", { status: 400 });

    await expect(provider.synthesize("key", "", geminiRequest)).rejects.toThrow("invalid voice");
    await expect(provider.synthesizeStream("key", "", geminiRequest).next()).rejects.toThrow("invalid voice");
  });
});
