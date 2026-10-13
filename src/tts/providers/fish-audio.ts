import type { TtsProvider } from "../provider";
import type { TtsParameterSchemaMap, TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

export const FISH_AUDIO_MODELS: Array<{ id: string; label: string }> = [
  { id: "s2.1-pro", label: "Fish S2.1 Pro (Recommended)" },
  { id: "s2.1-pro-free", label: "Fish S2.1 Pro Free (Zero-cost tier)" },
  { id: "s2-pro", label: "Fish S2 Pro" },
  { id: "s1", label: "Fish S1" },
  { id: "drama-3-preview", label: "Drama 3 (Preview)" },
];

const S2_MODELS = ["s2-pro", "s2.1-pro", "s2.1-pro-free"];
const EXPRESSIVE_MODELS = [...S2_MODELS, "drama-3-preview"];

export const FISH_AUDIO_SAMPLE_RATES: Record<string, number[]> = {
  wav: [8000, 16000, 24000, 32000, 44100],
  pcm: [8000, 16000, 24000, 32000, 44100],
  mp3: [32000, 44100],
  opus: [48000],
};

export const FISH_AUDIO_PARAMETERS: TtsParameterSchemaMap = {
  voice_direction: {
    type: "string",
    default: "",
    label: "Voice direction",
    description: "Describe the delivery in plain language, such as warm, measured, or barely holding back laughter. Inline directions can refine individual lines.",
    group: "delivery",
    models: EXPRESSIVE_MODELS,
  },
  format: {
    type: "select" as const,
    label: "Output format",
    default: "mp3",
    description: "Audio output format (mp3, wav, pcm, opus)",
    options: [
      { id: "mp3", label: "MP3" },
      { id: "wav", label: "WAV" },
      { id: "opus", label: "Opus" },
      { id: "pcm", label: "PCM" },
    ],
    group: "audio",
  },
  mp3_bitrate: {
    type: "select" as const,
    label: "MP3 bitrate",
    default: "128",
    description: "MP3 bitrate (kbps) — only applies when format is mp3",
    options: [
      { id: "64", label: "64 kbps" },
      { id: "128", label: "128 kbps" },
      { id: "192", label: "192 kbps" },
    ],
    group: "audio",
    formats: ["mp3"],
  },
  opus_bitrate: {
    type: "select",
    default: "-1000",
    label: "Opus bitrate",
    description: "Opus bitrate. Automatic lets Fish choose the bitrate.",
    options: [
      { id: "-1000", label: "Automatic" },
      { id: "24000", label: "24 kbps" },
      { id: "32000", label: "32 kbps" },
      { id: "48000", label: "48 kbps" },
      { id: "64000", label: "64 kbps" },
    ],
    group: "audio",
    formats: ["opus"],
  },
  sample_rate: {
    type: "select",
    default: "",
    label: "Sample rate",
    description: "Automatic uses the output format's default sample rate.",
    options: [
      { id: "", label: "Automatic" },
      ...[8000, 16000, 24000, 32000, 44100, 48000].map((rate) => ({ id: String(rate), label: `${rate / 1000} kHz` })),
    ],
    group: "audio",
  },
  latency: {
    type: "select" as const,
    default: "normal",
    description: "Trade audio quality for faster generation.",
    options: [
      { id: "normal", label: "Normal (Higher quality)" },
      { id: "balanced", label: "Balanced (Lower latency)" },
      { id: "low", label: "Low (Lowest latency)" },
    ],
    group: "audio",
  },
  speed: {
    type: "number" as const,
    default: 1.0,
    min: 0.5,
    max: 2.0,
    step: 0.05,
    description: "Playback speed (0.5x – 2.0x)",
    group: "delivery",
  },
  volume: {
    type: "number" as const,
    default: 0,
    step: 0.5,
    description: "Volume adjustment in decibels. Zero keeps the original volume.",
    group: "delivery",
  },
  normalize_loudness: {
    type: "boolean",
    default: true,
    label: "Normalize loudness",
    description: "Keep perceived volume consistent between generated passages.",
    group: "delivery",
    models: S2_MODELS,
  },
  temperature: {
    type: "number" as const,
    default: 0.7,
    min: 0,
    max: 1,
    step: 0.05,
    description: "Generation temperature (higher = more variance)",
    group: "sampling",
  },
  top_p: {
    type: "number" as const,
    default: 0.7,
    min: 0,
    max: 1,
    step: 0.05,
    description: "Top-p sampling probability threshold",
    label: "Top-p",
    group: "sampling",
  },
  repetition_penalty: {
    type: "number",
    default: 1.2,
    step: 0.05,
    label: "Repetition penalty",
    description: "Values above 1 reduce repeated audio patterns.",
    group: "sampling",
  },
  chunk_length: {
    type: "integer" as const,
    default: 300,
    min: 100,
    max: 300,
    step: 10,
    description: "Text chunk segment length (100–300)",
    label: "Chunk length",
    group: "generation",
  },
  min_chunk_length: {
    type: "integer",
    default: 50,
    min: 0,
    max: 100,
    step: 1,
    label: "Minimum chunk length",
    description: "Minimum characters before splitting into a new chunk.",
    group: "generation",
  },
  max_new_tokens: {
    type: "integer",
    default: 1024,
    step: 1,
    label: "Maximum audio tokens",
    description: "Maximum audio tokens per text chunk. A small limit can cut speech short.",
    group: "generation",
  },
  condition_on_previous_chunks: {
    type: "boolean",
    default: true,
    label: "Use previous chunks as context",
    description: "Use preceding audio to keep the voice consistent within a request.",
    group: "generation",
  },
  early_stop_threshold: {
    type: "number",
    default: 1,
    min: 0,
    max: 1,
    step: 0.05,
    label: "Early stopping threshold",
    description: "Early stopping threshold for batch processing.",
    group: "generation",
  },
  normalize: {
    type: "boolean" as const,
    default: true,
    description: "Normalize text before synthesis (numbers to words, etc.)",
    label: "Normalize numbers and text",
    group: "generation",
  },
  quality_guard: {
    type: "boolean",
    default: false,
    label: "Quality guard",
    description: "Request Fish's quality guard to reduce low-quality generations. Availability depends on the selected model.",
    group: "generation",
  },
  pronunciation_dictionary_id: {
    type: "string",
    default: "",
    label: "Dictionary ID",
    description: "Optional published pronunciation dictionary from Fish Audio.",
    group: "pronunciation",
  },
  pronunciation_dictionary_version: {
    type: "string",
    default: "",
    label: "Dictionary version",
    description: "Use the explicit published version ID for this dictionary.",
    group: "pronunciation",
  },
};

export function buildFishAudioBody(request: TtsRequest): Record<string, any> {
  const p = request.parameters || {};
  const model = request.model?.trim() || "s2.1-pro";
  const format = request.outputFormat || p.format || "mp3";
  const invalid = (detail: string): never => {
    throw new ProviderRequestError({
      provider: "Fish Audio",
      operation: "tts parameters",
      status: 400,
      code: "invalid_tts_parameters",
      detail,
      retryable: false,
    });
  };
  if (typeof format !== "string" || !Object.hasOwn(FISH_AUDIO_SAMPLE_RATES, format)) invalid("Unsupported audio format");
  const values: Record<string, any> = {};
  for (const [key, schema] of Object.entries(FISH_AUDIO_PARAMETERS)) {
    const value = p[key];
    if (value == null || value === "") continue;
    if (schema.models && !schema.models.includes(model)) continue;
    if (schema.formats && !schema.formats.includes(format)) continue;
    if (schema.type === "number" || schema.type === "integer") {
      if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") invalid(`${schema.label || key} requires a number`);
      const number = Number(value);
      if (!Number.isFinite(number) || (schema.type === "integer" && !Number.isInteger(number))) invalid(`${schema.label || key} requires a finite ${schema.type}`);
      if (schema.min != null && number < schema.min) invalid(`${schema.label || key} requires a value of at least ${schema.min}`);
      if (schema.max != null && number > schema.max) invalid(`${schema.label || key} requires a value of at most ${schema.max}`);
      values[key] = number;
    } else if (schema.type === "boolean") {
      if (value !== true && value !== false && value !== "true" && value !== "false") invalid(`${schema.label || key} requires true or false`);
      values[key] = value === true || value === "true";
    } else if (schema.type === "select") {
      if (!schema.options?.some((option) => option.id === String(value))) invalid(`Unsupported ${schema.label || key}`);
      values[key] = String(value);
    } else {
      if (typeof value !== "string") invalid(`${schema.label || key} requires text`);
      values[key] = value.trim();
    }
  }
  const body: Record<string, any> = {
    text: request.text,
    format,
  };
  if (request.voice && request.voice.trim()) {
    body.reference_id = request.voice.trim();
  }
  for (const key of [
    "latency", "chunk_length", "min_chunk_length", "max_new_tokens", "normalize",
    "temperature", "top_p", "repetition_penalty", "condition_on_previous_chunks", "early_stop_threshold",
  ]) {
    if (values[key] != null) body[key] = values[key];
  }
  for (const key of ["mp3_bitrate", "opus_bitrate", "sample_rate"]) {
    if (values[key] != null) body[key] = Number(values[key]);
  }
  if (body.sample_rate != null && !FISH_AUDIO_SAMPLE_RATES[format]!.includes(body.sample_rate)) invalid("Unsupported sample rate for the selected format");
  const speed = values.speed ?? 1;
  const volume = values.volume ?? 0;
  if (speed !== 1 || volume !== 0 || values.normalize_loudness != null) {
    body.prosody = { speed, volume };
    if (values.normalize_loudness != null) body.prosody.normalize_loudness = values.normalize_loudness;
  }
  if (values.voice_direction) {
    const direction = values.voice_direction.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
    if (direction) body.text = `[${direction}] ${request.text}`;
  }
  if (p.features != null && (!Array.isArray(p.features) || !p.features.every((flag: unknown) => typeof flag === "string"))) invalid("TTS features requires an array of strings");
  const features: string[] = [...(p.features || [])];
  if (values.quality_guard === true && !features.includes("quality-guard")) features.push("quality-guard");
  body.features = values.quality_guard === false ? features.filter((flag) => flag !== "quality-guard") : features;
  if (body.features.length === 0) delete body.features;
  if (p.pronunciation_dictionary != null) {
    if (!Array.isArray(p.pronunciation_dictionary) || p.pronunciation_dictionary.length > 3) invalid("Pronunciation dictionary requires an array of up to three dictionaries");
    body.pronunciation_dictionary = p.pronunciation_dictionary;
  } else if (values.pronunciation_dictionary_id || values.pronunciation_dictionary_version) {
    const id = values.pronunciation_dictionary_id;
    const version = values.pronunciation_dictionary_version;
    if (!id || !version) invalid("Pronunciation dictionary requires both an ID and a version");
    if (![id, version].every((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value))) invalid("Unsupported pronunciation dictionary ID or version");
    body.pronunciation_dictionary = [{ id, version }];
  }
  return body;
}

export class FishAudioTtsProvider implements TtsProvider {
  readonly name = "fish_audio";
  readonly displayName = "Fish Audio";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: { ...FISH_AUDIO_PARAMETERS },
    apiKeyRequired: true,
    voiceListStyle: "dynamic",
    staticVoices: [],
    modelListStyle: "static",
    staticModels: FISH_AUDIO_MODELS,
    supportsStreaming: true,
    supportedFormats: ["mp3", "wav", "pcm", "opus"],
    defaultUrl: "https://api.fish.audio",
    defaultFormat: "mp3",
  };

  private baseUrl(apiUrl: string): string {
    return (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
  }

  private headers(apiKey: string, model?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (model && model.trim()) {
      headers.model = model.trim();
    }
    return headers;
  }

  private contentTypeForFormat(format: string): string {
    switch (format) {
      case "wav":
        return "audio/wav";
      case "opus":
        return "audio/opus";
      case "pcm":
        return "audio/pcm";
      case "mp3":
      default:
        return "audio/mpeg";
    }
  }

  async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    if (!apiKey) {
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "tts synthesize",
        detail: "Missing Fish Audio API key",
        retryable: false,
      });
    }

    const body = buildFishAudioBody(request);
    const model = request.model?.trim() || "s2.1-pro";

    const res = await fetch(`${this.baseUrl(apiUrl)}/v1/tts`, {
      method: "POST",
      headers: this.headers(apiKey, model),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "tts synthesize", res);

    const audioData = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || this.contentTypeForFormat(body.format || "mp3");

    return {
      audioData,
      contentType,
      model,
      provider: this.name,
    };
  }

  async *synthesizeStream(
    apiKey: string,
    apiUrl: string,
    request: TtsRequest,
  ): AsyncGenerator<TtsStreamChunk, void, unknown> {
    if (!apiKey) {
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "tts stream",
        detail: "Missing Fish Audio API key",
        retryable: false,
      });
    }

    const body = buildFishAudioBody(request);
    const model = request.model?.trim() || "s2.1-pro";

    const res = await fetch(`${this.baseUrl(apiUrl)}/v1/tts`, {
      method: "POST",
      headers: this.headers(apiKey, model),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "tts stream", res);

    if (!res.body) {
      throw new Error("Fish Audio: no response body for streaming");
    }

    const mimeType = res.headers.get("content-type") || this.contentTypeForFormat(body.format || "mp3");
    const reader = res.body.getReader();
    try {
      while (true) {
        if (request.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) {
          yield { data: new Uint8Array(0), done: true, kind: "bytes", mimeType };
          break;
        }
        yield { data: value, done: false, kind: "bytes", mimeType };
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    if (!apiKey) {
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "authentication",
        detail: "Missing Fish Audio API key",
        retryable: false,
      });
    }

    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/model?page_size=1`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
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
    if (!apiKey) return this.capabilities.staticVoices || [];

    try {
      // Query user's own models first (self=true)
      let res = await fetch(`${this.baseUrl(apiUrl)}/model?self=true&page_size=100`, {
        headers: this.headers(apiKey),
      });
      let data = res.ok ? await res.json() : null;
      let items: any[] = data?.items || [];

      // If user has no models of their own, fall back to public/library models
      if (items.length === 0) {
        res = await fetch(`${this.baseUrl(apiUrl)}/model?page_size=100`, {
          headers: this.headers(apiKey),
        });
        data = res.ok ? await res.json() : null;
        items = data?.items || [];
      }

      const voices: TtsVoice[] = [];
      for (const item of items) {
        const id = item._id || item.id;
        if (!id) continue;
        voices.push({
          id,
          name: item.title || item.name || id,
          description: item.description || undefined,
          language: Array.isArray(item.languages) && item.languages[0] ? item.languages[0] : undefined,
        });
      }
      return voices.length > 0 ? voices : (this.capabilities.staticVoices || []);
    } catch {
      return this.capabilities.staticVoices || [];
    }
  }
}
