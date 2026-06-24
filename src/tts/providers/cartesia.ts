import type { TtsProvider } from "../provider";
import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

const CARTESIA_API_VERSION = "2026-03-01";
const CARTESIA_DEFAULT_SAMPLE_RATE = 22050;
const CARTESIA_DEFAULT_MP3_BITRATE = 128000;
const VOICES_PAGE_SIZE = 100;
const MAX_VOICE_PAGES = 50;

type OutputFormatContainer = "mp3" | "wav" | "raw";

export class CartesiaTtsProvider implements TtsProvider {
  readonly name = "cartesia";
  readonly displayName = "Cartesia";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: {
      output_format: {
        type: "select",
        default: "mp3",
        description: "Audio container for streamed output (MP3 is browser-friendly; WAV/PCM for downstream processing)",
        options: [
          { id: "mp3", label: "MP3 (browser-friendly)" },
          { id: "wav", label: "WAV (PCM s16le, 22.05 kHz)" },
          { id: "raw", label: "Raw PCM s16le, 22.05 kHz" },
        ],
      },
      language: {
        type: "string",
        description: "ISO 639-1 language code (e.g. en, fr, ja, zh) — forces a specific accent",
        group: "advanced",
      },
      volume: {
        type: "number",
        default: 1.0,
        min: 0.5,
        max: 2.0,
        step: 0.05,
        description: "Playback volume multiplier",
        group: "advanced",
      },
      speed: {
        type: "number",
        default: 1.0,
        min: 0.6,
        max: 1.5,
        step: 0.05,
        description: "Playback speed multiplier",
        group: "advanced",
      },
      emotion: {
        // string, not select — Cartesia supports 50+ emotions. A dropdown would be
        // unusable; a curated hint in the description preserves the full surface area
        // for users who edit default_parameters metadata directly.
        type: "string",
        description: "Emotion guide (e.g. neutral, happy, sad, calm, angry, scared). sonic-3+ only — see Cartesia docs for the full list of 50+ emotions.",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    voiceListStyle: "dynamic",
    modelListStyle: "static",
    staticModels: [
      { id: "sonic-3.5", label: "Sonic 3.5 (Recommended)" },
      { id: "sonic-3", label: "Sonic 3 (Stable)" },
      { id: "sonic-latest", label: "Sonic Latest (Beta — may change without notice)" },
    ],
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "raw"],
    defaultUrl: "https://api.cartesia.ai",
    defaultFormat: "mp3",
  };

  private baseUrl(apiUrl: string): string {
    return (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
  }

  // use a switch with no default — TS exhaustiveness check enforces every
  // container is handled and rejects drift when OutputFormatContainer grows.
  private buildOutputFormat(container: OutputFormatContainer): Record<string, any> {
    switch (container) {
      case "mp3":
        return { container: "mp3", sample_rate: CARTESIA_DEFAULT_SAMPLE_RATE, bit_rate: CARTESIA_DEFAULT_MP3_BITRATE };
      case "wav":
        return { container: "wav", encoding: "pcm_s16le", sample_rate: CARTESIA_DEFAULT_SAMPLE_RATE };
      case "raw":
        return { container: "raw", encoding: "pcm_s16le", sample_rate: CARTESIA_DEFAULT_SAMPLE_RATE };
    }
  }

  private headers(apiKey: string): Record<string, string> {
    // Cartesia-Version is required by the Cartesia API. It's a dated snapshot
    // pin — bump via code change when adopting a newer version.
    return {
      Authorization: `Bearer ${apiKey}`,
      "Cartesia-Version": CARTESIA_API_VERSION,
      "Content-Type": "application/json",
    };
  }

  private buildBody(request: TtsRequest): Record<string, any> {
    const p = request.parameters;
    const container: OutputFormatContainer = p.output_format || "mp3";
    const body: Record<string, any> = {
      model_id: request.model,
      transcript: request.text,
      voice: { mode: "id", id: request.voice },
      output_format: this.buildOutputFormat(container),
    };
    if (p.language) body.language = p.language;

    // generation_config is only supported on sonic-3+. Omit when all values
    // are defaults so we don't trigger model-version errors on older snapshots,
    // and so non-generation_config requests stay minimal.
    const hasGenConfig =
      (p.volume != null && p.volume !== 1.0) ||
      (p.speed != null && p.speed !== 1.0) ||
      !!p.emotion;
    if (hasGenConfig) {
      body.generation_config = {
        ...(p.volume != null && p.volume !== 1.0 ? { volume: p.volume } : {}),
        ...(p.speed != null && p.speed !== 1.0 ? { speed: p.speed } : {}),
        ...(p.emotion ? { emotion: p.emotion } : {}),
      };
    }
    return body;
  }

  async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    const base = this.baseUrl(apiUrl);
    const body = this.buildBody(request);

    const res = await fetch(`${base}/tts/bytes`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "tts synthesize", res);

    const audioData = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "audio/mpeg";

    return {
      audioData,
      contentType,
      model: request.model,
      provider: this.name,
    };
  }

  async *synthesizeStream(
    apiKey: string,
    apiUrl: string,
    request: TtsRequest
  ): AsyncGenerator<TtsStreamChunk, void, unknown> {
    const base = this.baseUrl(apiUrl);
    const body = this.buildBody(request);

    const res = await fetch(`${base}/tts/bytes`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "tts stream", res);

    if (!res.body) {
      throw new Error("Cartesia: no response body for streaming");
    }

    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          yield { data: new Uint8Array(0), done: true };
          break;
        }
        yield { data: value, done: false };
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    // Cartesia has no dedicated auth probe; /voices is the cheapest auth-required
    // endpoint. limit=1 minimizes the response size.
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/voices?limit=1`, { headers: this.headers(apiKey) });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return true;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "authentication",
        detail: err instanceof Error ? err.message : "network request failed",
        retryable: true,
      });
    }
  }

  async listModels(_apiKey: string, _apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    return this.capabilities.staticModels || [];
  }

  async listVoices(apiKey: string, apiUrl: string): Promise<TtsVoice[]> {
    // Cursor pagination — first paginated voice fetch in this codebase.
    // Cartesia returns { data: Voice[], has_more: boolean, next_page: string | null }.
    const collected: TtsVoice[] = [];
    let starting_after: string | undefined;
    let pages = 0;
    while (pages++ < MAX_VOICE_PAGES) {
      const qs = new URLSearchParams({ limit: String(VOICES_PAGE_SIZE) });
      if (starting_after) qs.set("starting_after", starting_after);
      const data = await fetchProviderJson<any>(this.displayName, "voice listing", `${this.baseUrl(apiUrl)}/voices?${qs}`, {
        headers: this.headers(apiKey),
      });
      for (const v of data.data || []) {
        collected.push({
          id: v.id,
          name: v.name,
          language: v.language,
          // Map Cartesia's masculine|feminine|gender_neutral to Lumiverse's
          // male|female|neutral convention (matches Kokoro's storage).
          gender:
            v.gender === "masculine" ? "male"
            : v.gender === "feminine" ? "female"
            : v.gender === "gender_neutral" ? "neutral"
            : undefined,
        });
      }
      if (!data.has_more || !data.next_page) break;
      starting_after = data.next_page;
    }
    return collected;
  }
}
