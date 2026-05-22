import type { TtsProvider } from "../provider";
import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  readonly displayName = "ElevenLabs";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: {
      stability: {
        type: "number",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
        description: "Voice stability — higher is more consistent, lower is more expressive",
      },
      similarity_boost: {
        type: "number",
        default: 0.75,
        min: 0,
        max: 1,
        step: 0.05,
        description: "Similarity boost — how closely the voice matches the original",
      },
      style: {
        type: "number",
        default: 0,
        min: 0,
        max: 1,
        step: 0.05,
        description: "Style exaggeration — amplifies the style of the voice",
        group: "advanced",
      },
      speed: {
        type: "number",
        default: 1.0,
        min: 0.7,
        max: 1.2,
        step: 0.05,
        description: "Playback speed",
      },
      use_speaker_boost: {
        type: "boolean",
        default: true,
        description: "Speaker boost — enhances clarity and voice quality",
      },
      language_code: {
        type: "string",
        description: "Language code (e.g. en, ja, de) — leave blank for auto-detect",
        group: "advanced",
      },
      output_format: {
        type: "select",
        default: "mp3_44100_128",
        description: "Output audio format",
        options: [
          { id: "mp3_22050_32", label: "MP3 22kHz 32kbps" },
          { id: "mp3_44100_64", label: "MP3 44kHz 64kbps" },
          { id: "mp3_44100_96", label: "MP3 44kHz 96kbps" },
          { id: "mp3_44100_128", label: "MP3 44kHz 128kbps" },
          { id: "mp3_44100_192", label: "MP3 44kHz 192kbps" },
          { id: "pcm_16000", label: "PCM 16kHz" },
          { id: "pcm_22050", label: "PCM 22kHz" },
          { id: "pcm_24000", label: "PCM 24kHz" },
          { id: "pcm_44100", label: "PCM 44kHz" },
          { id: "ulaw_8000", label: "uLaw 8kHz" },
        ],
      },
    },
    apiKeyRequired: true,
    voiceListStyle: "dynamic",
    modelListStyle: "static",
    staticModels: [
      { id: "eleven_v3", label: "Eleven v3 (Most Expressive)" },
      { id: "eleven_multilingual_v2", label: "Eleven Multilingual v2" },
      { id: "eleven_flash_v2_5", label: "Eleven Flash v2.5 (Low Latency)" },
    ],
    supportsStreaming: true,
    supportedFormats: [
      "mp3_22050_32", "mp3_44100_64", "mp3_44100_96", "mp3_44100_128", "mp3_44100_192",
      "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100", "ulaw_8000",
    ],
    defaultUrl: "https://api.elevenlabs.io",
    defaultFormat: "mp3_44100_128",
  };

  private baseUrl(apiUrl: string): string {
    return (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    };
  }

  private buildBody(request: TtsRequest): Record<string, any> {
    const p = request.parameters;
    const body: Record<string, any> = {
      text: request.text,
      model_id: request.model,
      voice_settings: {
        stability: p.stability ?? 0.5,
        similarity_boost: p.similarity_boost ?? 0.75,
        style: p.style ?? 0,
        speed: p.speed ?? 1.0,
        use_speaker_boost: p.use_speaker_boost ?? true,
      },
    };
    if (p.language_code) {
      body.language_code = p.language_code;
    }
    return body;
  }

  async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    const base = this.baseUrl(apiUrl);
    const format = request.parameters.output_format || this.capabilities.defaultFormat;
    const url = `${base}/v1/text-to-speech/${request.voice}?output_format=${format}`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      throw new Error(`ElevenLabs API error ${res.status}: ${err}`);
    }

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
    const format = request.parameters.output_format || this.capabilities.defaultFormat;
    const url = `${base}/v1/text-to-speech/${request.voice}/stream?output_format=${format}`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      throw new Error(`ElevenLabs API error ${res.status}: ${err}`);
    }

    if (!res.body) {
      throw new Error("ElevenLabs: no response body for streaming");
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
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/v1/user/subscription`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(_apiKey: string, _apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    return this.capabilities.staticModels || [];
  }

  async listVoices(apiKey: string, apiUrl: string): Promise<TtsVoice[]> {
    const data = await fetchProviderJson<any>(this.displayName, "voice listing", `${this.baseUrl(apiUrl)}/v1/voices`, {
      headers: this.headers(apiKey),
    });
    return (data.voices || []).map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      language: v.labels?.language,
      gender: v.labels?.gender,
      previewUrl: v.preview_url,
    }));
  }
}
