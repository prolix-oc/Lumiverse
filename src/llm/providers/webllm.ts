import type { LlmProvider } from "../provider";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../types";
import type { ProviderCapabilities } from "../param-schema";
import { COMMON_PARAMS } from "../param-schema";

// WebLLM: This provider is a backend stub only. All actual generation happens
// in the browser via @mlc-ai/web-llm. The backend stub allows the database to
// accept connections with provider: "webllm" without the generation pipeline
// ever being invoked — InputArea.tsx intercepts and short-circuits before
// POST /generate is sent.
export class WebllmProvider implements LlmProvider {
  readonly name = "webllm";
  readonly displayName = "WebLLM (In-Browser)";
  readonly defaultUrl = "";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature },
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "none",
  };

  generate(_apiKey: string, _apiUrl: string, _request: GenerationRequest): Promise<GenerationResponse> {
    throw new Error("WebLLM runs in the browser — this should never be called");
  }

  async *generateStream(_apiKey: string, _apiUrl: string, _request: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    throw new Error("WebLLM runs in the browser — this should never be called");
  }

  async validateKey(_apiKey: string, _apiUrl: string): Promise<boolean> {
    return true;
  }

  async listModels(_apiKey: string, _apiUrl: string): Promise<string[]> {
    return [];
  }
}
