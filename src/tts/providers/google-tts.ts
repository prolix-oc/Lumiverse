import type { TtsProvider } from "../provider";
import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import {
  GOOGLE_TTS_MODELS as GOOGLE_TTS_FALLBACK_MODELS,
  GOOGLE_TTS_PARAMETERS,
  GOOGLE_TTS_VOICES,
  buildGeminiTtsBody,
  extractGeminiTtsAudio,
  isTtsModelId,
  streamGeminiTtsAudio,
} from "./google-tts-shared";

/**
 * Google AI Studio text-to-speech. Auth mirrors the Gemini text connection:
 * a plain API key. TTS-only model list with mapped prebuilt voices.
 */
export class GoogleTtsProvider implements TtsProvider {
  readonly name = "google_tts";
  readonly displayName = "Google AI Studio TTS";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: { ...GOOGLE_TTS_PARAMETERS },
    apiKeyRequired: true,
    voiceListStyle: "static",
    staticVoices: GOOGLE_TTS_VOICES,
    modelListStyle: "dynamic",
    staticModels: GOOGLE_TTS_FALLBACK_MODELS,
    supportsStreaming: true,
    supportedFormats: ["wav"],
    defaultUrl: "https://generativelanguage.googleapis.com",
    defaultFormat: "wav",
  };

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
    url = url.replace(/\/v1beta\/models(\/.*)?$/, "");
    url = url.replace(/\/v1beta$/, "");
    return url;
  }

  async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    if (!apiKey) {
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "tts synthesize",
        detail: "Missing Google AI Studio API key",
        retryable: false,
      });
    }
    if (!request.voice) {
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "tts synthesize",
        detail: "No voice selected",
        retryable: false,
      });
    }
    const url = `${this.baseUrl(apiUrl)}/v1beta/models/${request.model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildGeminiTtsBody(request)),
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "tts synthesize", res);
    const data = await res.json();
    const { audioData, contentType } = extractGeminiTtsAudio(data);
    return { audioData, contentType, model: request.model, provider: this.name };
  }

  async *synthesizeStream(
    apiKey: string,
    apiUrl: string,
    request: TtsRequest,
  ): AsyncGenerator<TtsStreamChunk, void, unknown> {
    if (!request.voice) {
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "tts stream",
        detail: "No voice selected",
        retryable: false,
      });
    }
    const url = `${this.baseUrl(apiUrl)}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGeminiTtsBody(request)),
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "tts stream", res);
    yield* streamGeminiTtsAudio(res, request.signal);
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    // Live TTS-only listing with a static fallback, so new speech models
    // appear without a Lumiverse update.
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) return this.capabilities.staticModels || [];
      const data = await res.json();
      const models: any[] = data.models || [];
      const ids = models
        .map((m: any) => String(m.name || "").replace(/^models\//, ""))
        .filter((id) => id && isTtsModelId(id));
      if (ids.length === 0) return this.capabilities.staticModels || [];
      return [...new Set(ids)].sort().map((id) => ({ id, label: id }));
    } catch {
      return this.capabilities.staticModels || [];
    }
  }

  async listVoices(_apiKey: string, _apiUrl: string): Promise<TtsVoice[]> {
    return this.capabilities.staticVoices || [];
  }
}
