import { afterEach, describe, expect, test } from "bun:test";
import { FishAudioTtsProvider, FISH_AUDIO_MODELS, buildFishAudioBody } from "./fish-audio";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("FishAudioTtsProvider metadata and capabilities", () => {
  const provider = new FishAudioTtsProvider();

  test("uses provider name fish_audio and display name Fish Audio", () => {
    expect(provider.name).toBe("fish_audio");
    expect(provider.displayName).toBe("Fish Audio");
  });

  test("declares expected capabilities and static models", () => {
    expect(provider.capabilities.apiKeyRequired).toBe(true);
    expect(provider.capabilities.supportsStreaming).toBe(true);
    expect(provider.capabilities.defaultUrl).toBe("https://api.fish.audio");
    expect(provider.capabilities.defaultFormat).toBe("mp3");
    expect(provider.capabilities.supportedFormats).toEqual(["mp3", "wav", "pcm", "opus"]);
    expect(provider.capabilities.modelListStyle).toBe("static");
    expect(provider.capabilities.staticModels).toEqual(FISH_AUDIO_MODELS);
    expect(FISH_AUDIO_MODELS.map((m) => m.id)).toContain("s2.1-pro");
    expect(FISH_AUDIO_MODELS.map((m) => m.id)).toContain("s2.1-pro-free");
  });
});

describe("buildFishAudioBody", () => {
  test("builds minimal request body with text and default format", () => {
    const body = buildFishAudioBody({
      text: "Hello world",
      model: "s2.1-pro",
      voice: "",
      parameters: {},
    });
    expect(body.text).toBe("Hello world");
    expect(body.format).toBe("mp3");
    expect(body).not.toHaveProperty("reference_id");
    expect(body).not.toHaveProperty("prosody");
  });

  test("includes reference_id when voice is provided", () => {
    const body = buildFishAudioBody({
      text: "Hello",
      model: "s2.1-pro",
      voice: "custom-voice-uuid-123",
      parameters: {},
    });
    expect(body.reference_id).toBe("custom-voice-uuid-123");
  });

  test("maps prosody when speed or volume differ from defaults", () => {
    const body = buildFishAudioBody({
      text: "Hello",
      model: "s2.1-pro",
      voice: "v1",
      parameters: { speed: 1.25, volume: 2.5 },
    });
    expect(body.prosody).toEqual({ speed: 1.25, volume: 2.5 });
  });

  test("maps custom parameters and format overrides", () => {
    const body = buildFishAudioBody({
      text: "Testing options",
      model: "s2.1-pro",
      voice: "v1",
      outputFormat: "opus",
      parameters: {
        latency: "balanced",
        chunk_length: 200,
        normalize: false,
        temperature: 0.8,
        top_p: 0.9,
      },
    });
    expect(body.format).toBe("opus");
    expect(body.latency).toBe("balanced");
    expect(body.chunk_length).toBe(200);
    expect(body.normalize).toBe(false);
    expect(body.temperature).toBe(0.8);
    expect(body.top_p).toBe(0.9);
  });

  test("includes mp3_bitrate only for mp3 format", () => {
    const mp3Body = buildFishAudioBody({
      text: "Audio",
      model: "s2.1-pro",
      voice: "",
      parameters: { format: "mp3", mp3_bitrate: 192 },
    });
    expect(mp3Body.mp3_bitrate).toBe(192);

    const wavBody = buildFishAudioBody({
      text: "Audio",
      model: "s2.1-pro",
      voice: "",
      parameters: { format: "wav", mp3_bitrate: 192 },
    });
    expect(wavBody).not.toHaveProperty("mp3_bitrate");
  });

  test("preserves zero/false generation controls and maps quality guard", () => {
    const body = buildFishAudioBody({ text: "Hello", model: "s2.1-pro", voice: "", parameters: {
      temperature: 0, top_p: 0, min_chunk_length: 0, early_stop_threshold: 0,
      repetition_penalty: 1.4, max_new_tokens: 2048, condition_on_previous_chunks: false,
      normalize: "false", normalize_loudness: "false", quality_guard: true,
    } });
    expect(body).toEqual({ text: "Hello", format: "mp3", temperature: 0, top_p: 0,
      min_chunk_length: 0, early_stop_threshold: 0, repetition_penalty: 1.4, max_new_tokens: 2048,
      condition_on_previous_chunks: false, normalize: false,
      prosody: { speed: 1, volume: 0, normalize_loudness: false }, features: ["quality-guard"],
    });
  });

  test("maps Opus settings using the effective format and omits MP3 bitrate", () => {
    expect(buildFishAudioBody({ text: "Hello", model: "s2-pro", voice: "", outputFormat: "opus", parameters: {
      format: "mp3", sample_rate: "48000", opus_bitrate: "-1000", mp3_bitrate: 192,
    } })).toEqual({ text: "Hello", format: "opus", sample_rate: 48000, opus_bitrate: -1000 });
  });

  test("only sends loudness normalization to documented S2 models", () => {
    expect(buildFishAudioBody({ text: "Hello", model: "drama-3-preview", voice: "", parameters: {
      normalize_loudness: false, voice_direction: "[warm and measured]", speed: 1.1,
    } })).toEqual({ text: "[warm and measured] Hello", format: "mp3", prosody: { speed: 1.1, volume: 0 } });
    expect(buildFishAudioBody({ text: "Hello", model: "s1", voice: "", parameters: { voice_direction: "warm" } }).text).toBe("Hello");
  });

  test("published dictionary IDs require an explicit version", () => {
    expect(buildFishAudioBody({ text: "Hello", model: "s2.1-pro", voice: "", parameters: {
      pronunciation_dictionary_id: "cast_names", pronunciation_dictionary_version: "version-2",
    } }).pronunciation_dictionary).toEqual([{ id: "cast_names", version: "version-2" }]);
    expect(() => buildFishAudioBody({ text: "Hello", model: "s2.1-pro", voice: "", parameters: {
      pronunciation_dictionary_id: "cast_names",
    } })).toThrow("requires both an ID and a version");
  });

  test("an explicit quality guard override preserves other feature flags", () => {
    expect(buildFishAudioBody({ text: "Hello", model: "s2.1-pro", voice: "", parameters: {
      features: ["quality-guard", "other-feature"], quality_guard: false,
    } }).features).toEqual(["other-feature"]);
  });

  test.each([
    { temperature: 1.1 }, { min_chunk_length: -1 }, { chunk_length: 200.5 },
    { speed: "invalid" }, { normalize: "no" }, { repetition_penalty: Infinity },
    { format: "mp3", sample_rate: 8000 }, { format: "opus", opus_bitrate: 128 },
  ])("rejects invalid settings before making a provider request: %j", (parameters) => {
    expect(() => buildFishAudioBody({ text: "Hello", model: "s2.1-pro", voice: "", parameters })).toThrow();
  });
});

describe("FishAudioTtsProvider synthesis and streaming", () => {
  const provider = new FishAudioTtsProvider();

  test("synthesize posts to /v1/tts with Bearer token, model header, and parses audio response", async () => {
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
        headers: { "content-type": "audio/mpeg" },
      });
    };

    const res = await provider.synthesize("test-api-key", "https://api.fish.audio", {
      text: "Synthesize this text",
      model: "s2.1-pro",
      voice: "ref-model-id",
      parameters: { speed: 1.1 },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.fish.audio/v1/tts");
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-api-key");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(calls[0].headers.get("model")).toBe("s2.1-pro");
    expect(calls[0].body.text).toBe("Synthesize this text");
    expect(calls[0].body.reference_id).toBe("ref-model-id");
    expect(calls[0].body.prosody).toEqual({ speed: 1.1, volume: 0 });

    expect(res.provider).toBe("fish_audio");
    expect(res.model).toBe("s2.1-pro");
    expect(res.contentType).toBe("audio/mpeg");
    expect(new Uint8Array(res.audioData)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("synthesize requires API key", async () => {
    await expect(
      provider.synthesize("", "", { text: "hi", model: "s2.1-pro", voice: "", parameters: {} })
    ).rejects.toThrow("Missing Fish Audio API key");
  });

  test("synthesizeStream yields byte chunks", async () => {
    const chunk1 = new Uint8Array([10, 20]);
    const chunk2 = new Uint8Array([30, 40]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    (globalThis as any).fetch = async () =>
      new Response(stream, { headers: { "content-type": "audio/mpeg" } });

    const chunks: any[] = [];
    for await (const chunk of provider.synthesizeStream("api-key", "", {
      text: "Stream this",
      model: "s2.1-pro",
      voice: "",
      parameters: {},
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ data: chunk1, done: false, kind: "bytes", mimeType: "audio/mpeg" });
    expect(chunks[1]).toEqual({ data: chunk2, done: false, kind: "bytes", mimeType: "audio/mpeg" });
    expect(chunks[2]).toEqual({ data: new Uint8Array(0), done: true, kind: "bytes", mimeType: "audio/mpeg" });
  });

  test("buffered and streaming synthesis send the same advanced settings", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("model")).toBe("drama-3-preview");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;
    const request = { text: "<whisper>Hello.</whisper>", model: " drama-3-preview ", voice: "", parameters: {
      repetition_penalty: 1.3, normalize: false, condition_on_previous_chunks: false,
      quality_guard: true, voice_direction: "quiet, hesitant",
    } };
    await provider.synthesize("key", "", request);
    for await (const _chunk of provider.synthesizeStream("key", "", request)) { /* drain */ }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0].text).toBe("[quiet, hesitant] <whisper>Hello.</whisper>");
    expect(bodies[0].condition_on_previous_chunks).toBe(false);
  });
});

describe("FishAudioTtsProvider auth and listing", () => {
  const provider = new FishAudioTtsProvider();

  test("validateKey probes /model?page_size=1 with Bearer token", async () => {
    const urls: string[] = [];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      urls.push(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer valid-key");
      return new Response(JSON.stringify({ total: 1, items: [] }));
    };

    const valid = await provider.validateKey("valid-key", "https://api.fish.audio");
    expect(valid).toBe(true);
    expect(urls[0]).toBe("https://api.fish.audio/model?page_size=1");
  });

  test("validateKey throws on 401 unauthorized", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });

    await expect(provider.validateKey("bad-key", "")).rejects.toThrow();
  });

  test("listVoices parses self=true models", async () => {
    (globalThis as any).fetch = async (input: any) => {
      if (String(input).includes("self=true")) {
        return new Response(
          JSON.stringify({
            total: 2,
            items: [
              { _id: "voice-1", title: "Alice", description: "Friendly narrator", languages: ["en"] },
              { _id: "voice-2", title: "Bob", description: "Deep voice", languages: ["en"] },
            ],
          })
        );
      }
      return new Response("{}", { status: 404 });
    };

    const voices = await provider.listVoices("key", "");
    expect(voices).toEqual([
      { id: "voice-1", name: "Alice", description: "Friendly narrator", language: "en" },
      { id: "voice-2", name: "Bob", description: "Deep voice", language: "en" },
    ]);
  });

  test("listVoices falls back to public models when self=true has no items", async () => {
    (globalThis as any).fetch = async (input: any) => {
      if (String(input).includes("self=true")) {
        return new Response(JSON.stringify({ total: 0, items: [] }));
      }
      return new Response(
        JSON.stringify({
          total: 1,
          items: [{ _id: "public-1", title: "Community Voice", description: "Public", languages: ["ja"] }],
        })
      );
    };

    const voices = await provider.listVoices("key", "");
    expect(voices).toEqual([
      { id: "public-1", name: "Community Voice", description: "Public", language: "ja" },
    ]);
  });
});
