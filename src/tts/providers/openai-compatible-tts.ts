import type { TtsProvider } from "../provider";
import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

/**
 * Abstract base class for providers that use the OpenAI-compatible
 * /audio/speech API format. Shared by OpenAI TTS and Kokoro TTS.
 */
export abstract class OpenAICompatibleTtsProvider implements TtsProvider {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: TtsProviderCapabilities;

  protected get defaultUrl(): string {
    return this.capabilities.defaultUrl;
  }

  protected baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.defaultUrl).replace(/\/+$/, "");
    url = url.replace(/\/audio\/speech$/, "");
    return url;
  }

  protected filterModels(data: any): Array<{ id: string; label: string }> {
    const models: any[] = Array.isArray(data?.data) ? data.data : [];
    return models
      .map((model: any) => typeof model === "string" ? model : model?.id)
      .filter((id: unknown): id is string => typeof id === "string" && /(?:^|[-_.:/])(tts|speech)(?:$|[-_.:/])/i.test(id))
      .map((id) => ({ id, label: id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Override to add provider-specific headers. */
  protected extraHeaders(_apiKey: string): Record<string, string> {
    return {};
  }

  protected headers(apiKey: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders(apiKey),
    };
    if (apiKey) {
      h["Authorization"] = `Bearer ${apiKey}`;
    }
    return h;
  }

  /** Build the request body. Override in subclasses for provider-specific fields. */
  protected buildBody(request: TtsRequest): Record<string, any> {
    return {
      model: request.model,
      input: request.text,
      voice: request.voice,
      response_format: request.outputFormat || this.capabilities.defaultFormat,
      speed: request.parameters.speed ?? 1.0,
    };
  }

  async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    const url = `${this.baseUrl(apiUrl)}/audio/speech`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      throw new Error(`${this.name} API error ${res.status}: ${err}`);
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
    const url = `${this.baseUrl(apiUrl)}/audio/speech`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      throw new Error(`${this.name} API error ${res.status}: ${err}`);
    }

    if (!res.body) {
      throw new Error(`${this.name}: no response body for streaming`);
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
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    if (this.capabilities.modelListStyle === "static") return this.capabilities.staticModels || [];

    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${this.baseUrl(apiUrl)}/models`, {
      headers: this.headers(apiKey),
    });
    return this.filterModels(data);
  }

  async listVoices(_apiKey: string, _apiUrl: string): Promise<TtsVoice[]> {
    return this.capabilities.staticVoices || [];
  }
}
