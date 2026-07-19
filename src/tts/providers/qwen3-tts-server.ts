import type { TtsProvider } from "../provider";
import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "../types";
import {
  QWEN_TTS_PROVIDER,
  parseQwenVoice,
  qwenApiBaseUrl,
  qwenSpeakerVoiceId,
  type QwenModelHealth,
} from "./qwen3-utils";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

const QWEN_LANGUAGE_OPTIONS = [
  "Auto",
  "Chinese",
  "English",
  "Japanese",
  "Korean",
  "German",
  "French",
  "Russian",
  "Portuguese",
  "Spanish",
  "Italian",
].map((language) => ({ id: language, label: language }));

interface QwenSpeakersResponse {
  speakers?: Array<{
    name?: string;
    native_language?: string;
  }>;
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

function parseSseEventBlock(rawBlock: string): ParsedSseEvent | null {
  const lines = rawBlock.replace(/\r/g, "").split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (event === "message" && dataLines.length === 0) return null;
  return {
    event,
    data: dataLines.join("\n"),
  };
}

function parseQwenStreamEvent(rawBlock: string): ParsedSseEvent | null {
  const outer = parseSseEventBlock(rawBlock);
  if (!outer) return null;
  if (!outer.data) return outer;
  if (!/(?:^|\n)(?:event|data):/.test(outer.data)) return outer;
  return parseSseEventBlock(outer.data) || outer;
}

function parseQwenStreamError(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Qwen3-TTS Server streaming failed";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as any;
      if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
      if (typeof data?.detail === "string" && data.detail.trim()) return data.detail.trim();
      if (typeof data?.message === "string" && data.message.trim()) return data.message.trim();
    } catch {
      // Fall through to the raw payload.
    }
  }
  return trimmed;
}

export class Qwen3TtsServerProvider implements TtsProvider {
  readonly name = QWEN_TTS_PROVIDER;
  readonly displayName = "Qwen3-TTS Server";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: {
      language: {
        type: "select",
        default: "Auto",
        description: "Language routing for synthesis. Leave on Auto unless the server struggles to infer the target language.",
        options: QWEN_LANGUAGE_OPTIONS,
      },
      instruct: {
        type: "string",
        description: "Optional style instruction for built-in speakers (for example: 'Warm, whispered, close-mic').",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    voiceListStyle: "dynamic",
    modelListStyle: "static",
    staticModels: [
      { id: "auto", label: "Auto (speakers + saved clones)" },
    ],
    supportsStreaming: true,
    supportedFormats: ["wav", "base64"],
    defaultUrl: "http://localhost:8000",
    defaultFormat: "wav",
  };

  private headers(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["X-API-Key"] = apiKey;
    return headers;
  }

  private async modelHealth(apiUrl: string): Promise<QwenModelHealth> {
    return fetchProviderJson<QwenModelHealth>(
      this.displayName,
      "model health",
      `${qwenApiBaseUrl(apiUrl)}/health/models`,
      { headers: { Accept: "application/json" } },
    );
  }

  async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    const parsedVoice = parseQwenVoice(request.voice || "");
    if (!parsedVoice) {
      throw new Error("Qwen3-TTS Server requires a voice selection");
    }

    const baseUrl = qwenApiBaseUrl(apiUrl);
    const responseFormat = request.outputFormat || this.capabilities.defaultFormat;
    const language = request.parameters.language || "Auto";
    let url = "";
    let body: Record<string, any>;

    if (parsedVoice.kind === "prompt") {
      url = `${baseUrl}/api/v1/base/generate-with-prompt`;
      body = {
        text: request.text,
        language,
        prompt_id: parsedVoice.promptId,
        response_format: responseFormat,
      };
    } else {
      url = `${baseUrl}/api/v1/custom-voice/generate`;
      body = {
        text: request.text,
        language,
        speaker: parsedVoice.speaker,
        speed: request.parameters.speed ?? 1.0,
        response_format: responseFormat,
      };
      if (request.parameters.instruct) {
        body.instruct = request.parameters.instruct;
      }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "tts synthesize", res);

    const audioData = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "audio/wav";

    return {
      audioData,
      contentType,
      model: request.model || "auto",
      provider: this.name,
    };
  }

  async *synthesizeStream(
    apiKey: string,
    apiUrl: string,
    request: TtsRequest,
  ): AsyncGenerator<TtsStreamChunk, void, unknown> {
    const parsedVoice = parseQwenVoice(request.voice || "");
    if (!parsedVoice) {
      throw new Error("Qwen3-TTS Server requires a voice selection");
    }
    if (parsedVoice.kind === "prompt") {
      throw new Error("Qwen3-TTS Server does not support streaming for saved cloned prompt voices");
    }

    const baseUrl = qwenApiBaseUrl(apiUrl);
    const body: Record<string, any> = {
      text: request.text,
      language: request.parameters.language || "Auto",
      speaker: parsedVoice.speaker,
      speed: request.parameters.speed ?? 1.0,
      // The upstream stream endpoint yields standalone WAV chunks. Force WAV so
      // the frontend can decode or persist each chunk independently.
      response_format: "wav",
    };
    if (request.parameters.instruct) {
      body.instruct = request.parameters.instruct;
    }

    const res = await fetch(`${baseUrl}/api/v1/custom-voice/generate-stream`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "tts stream", res);
    if (!res.body) {
      throw new Error("Qwen3-TTS Server: no response body for streaming");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const yieldBlock = async function* (block: string): AsyncGenerator<TtsStreamChunk, void, unknown> {
      const event = parseQwenStreamEvent(block);
      if (!event) return;

      if (event.event === "audio") {
        const encoded = event.data.trim();
        if (!encoded) return;
        const chunk = Buffer.from(encoded, "base64");
        if (chunk.byteLength === 0) return;
        yield {
          data: new Uint8Array(chunk),
          done: false,
          kind: "audio_file",
          mimeType: "audio/wav",
        };
        return;
      }

      if (event.event === "error") {
        throw new Error(parseQwenStreamError(event.data));
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseQwenStreamEvent(block);
          if (parsed?.event === "done") {
            yield { data: new Uint8Array(0), done: true, kind: "audio_file", mimeType: "audio/wav" };
            return;
          }
          yield* yieldBlock(block);
          boundary = buffer.indexOf("\n\n");
        }
      }

      buffer += decoder.decode().replace(/\r/g, "");
      if (buffer.trim()) {
        const parsed = parseQwenStreamEvent(buffer);
        if (parsed?.event === "done") {
          yield { data: new Uint8Array(0), done: true, kind: "audio_file", mimeType: "audio/wav" };
          return;
        }
        yield* yieldBlock(buffer);
      }

      yield { data: new Uint8Array(0), done: true, kind: "audio_file", mimeType: "audio/wav" };
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const health = await this.modelHealth(apiUrl);
      const baseUrl = qwenApiBaseUrl(apiUrl);

      let probeUrl = "";
      if (health.custom_voice_loaded) {
        probeUrl = `${baseUrl}/api/v1/custom-voice/languages`;
      } else if (health.base_loaded) {
        probeUrl = `${baseUrl}/api/v1/base/cache/stats`;
      } else {
        throw new Error("No usable Qwen TTS models are loaded on the server");
      }

      const res = await fetch(probeUrl, { headers: this.headers(apiKey) });
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
    const health = await this.modelHealth(apiUrl);
    if (!health.custom_voice_loaded) return [];

    const data = await fetchProviderJson<QwenSpeakersResponse>(
      this.displayName,
      "voice listing",
      `${qwenApiBaseUrl(apiUrl)}/api/v1/custom-voice/speakers`,
      { headers: this.headers(apiKey) },
    );

    const voices: TtsVoice[] = [];
    for (const speaker of data.speakers || []) {
      const name = typeof speaker?.name === "string" ? speaker.name.trim() : "";
      if (!name) continue;
      voices.push({
        id: qwenSpeakerVoiceId(name),
        name,
        language: typeof speaker?.native_language === "string" ? speaker.native_language : undefined,
      });
    }
    voices.sort((a, b) => a.name.localeCompare(b.name));
    return voices;
  }
}
