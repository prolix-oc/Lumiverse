import type { TtsProvider } from "../provider";
import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "../types";
import { ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";
import {
  getAccessToken,
  parseServiceAccount,
  vertexHostForLocation,
} from "../../llm/providers/google-vertex";
import {
  GOOGLE_TTS_MODELS,
  GOOGLE_TTS_PARAMETERS,
  GOOGLE_TTS_VOICES,
  buildGeminiTtsBody,
  extractGeminiTtsAudio,
  isTtsModelId,
  streamGeminiTtsAudio,
} from "./google-tts-shared";

/**
 * Google Vertex AI text-to-speech. Auth mirrors the Vertex text connection:
 * the API-key slot holds the service account JSON. The API URL selects the
 * location (blank = global, or paste a regional host such as
 * https://us-central1-aiplatform.googleapis.com). TTS-only model list with
 * mapped prebuilt voices.
 */
export class GoogleVertexTtsProvider implements TtsProvider {
  readonly name = "google_vertex_tts";
  readonly displayName = "Google Vertex TTS";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: { ...GOOGLE_TTS_PARAMETERS },
    apiKeyRequired: true, // Service account JSON, like the Vertex text connection
    voiceListStyle: "static",
    staticVoices: GOOGLE_TTS_VOICES,
    modelListStyle: "dynamic",
    staticModels: GOOGLE_TTS_MODELS,
    supportsStreaming: true,
    supportedFormats: ["wav"],
    defaultUrl: "https://aiplatform.googleapis.com",
    defaultFormat: "wav",
  };

  private resolveProject(apiKey: string, apiUrl: string): { projectId: string; location: string; host: string } {
    const sa = parseServiceAccount(apiKey);
    let location = "global";
    const parsedUrl = (apiUrl || "").trim() || this.capabilities.defaultUrl;
    const regionalMatch = parsedUrl.match(/^https?:\/\/([a-z0-9-]+)-aiplatform\.googleapis\.com/);
    if (regionalMatch) {
      location = regionalMatch[1];
    } else if (/^[a-z0-9-]+$/.test(parsedUrl) && parsedUrl !== "global") {
      location = parsedUrl;
    }
    return { projectId: sa.project_id, location, host: vertexHostForLocation(location) };
  }

  async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    if (!request.voice) {
      throw new ProviderRequestError({
        provider: this.displayName,
        operation: "tts synthesize",
        detail: "No voice selected",
        retryable: false,
      });
    }
    const sa = parseServiceAccount(apiKey);
    const { projectId, location, host } = this.resolveProject(apiKey, apiUrl);
    const accessToken = await getAccessToken(sa);
    const url = `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${request.model}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
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
    const sa = parseServiceAccount(apiKey);
    const { projectId, location, host } = this.resolveProject(apiKey, apiUrl);
    const accessToken = await getAccessToken(sa);
    const url = `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${request.model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(buildGeminiTtsBody(request)),
      signal: request.signal,
    });
    if (!res.ok) await throwProviderResponseError(this.displayName, "tts stream", res);
    yield* streamGeminiTtsAudio(res, request.signal);
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const sa = parseServiceAccount(apiKey);
      const accessToken = await getAccessToken(sa);
      const { host } = this.resolveProject(apiKey, apiUrl);
      const res = await fetch(`${host}/v1beta1/publishers/google/models?pageSize=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
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
      const sa = parseServiceAccount(apiKey);
      const accessToken = await getAccessToken(sa);
      const { host } = this.resolveProject(apiKey, apiUrl);
      const seen = new Set<string>();
      let pageToken = "";
      do {
        const params = new URLSearchParams({ pageSize: "100" });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await fetch(`${host}/v1beta1/publishers/google/models?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return this.capabilities.staticModels || [];
        const data = await res.json();
        const models: any[] = data.publisherModels || data.models || [];
        for (const m of models) {
          const id = String(m.name || "").replace(/^publishers\/google\/models\//, "");
          if (id && isTtsModelId(id)) seen.add(id);
        }
        pageToken = data.nextPageToken || "";
      } while (pageToken);
      if (seen.size === 0) return this.capabilities.staticModels || [];
      return [...seen].sort().map((id) => ({ id, label: id }));
    } catch {
      return this.capabilities.staticModels || [];
    }
  }

  async listVoices(_apiKey: string, _apiUrl: string): Promise<TtsVoice[]> {
    return this.capabilities.staticVoices || [];
  }
}
