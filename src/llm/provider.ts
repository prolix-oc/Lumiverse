import type { GenerationRequest, GenerationResponse, StreamChunk } from "./types";
import type { ProviderCapabilities } from "./param-schema";

/** Saved connection settings a provider can read when testing a key or listing models. */
export interface ProviderConnectionOptions {
  metadata?: Record<string, any>;
}

export interface LlmProvider {
  readonly name: string;
  readonly displayName: string;
  readonly defaultUrl: string;
  readonly capabilities: ProviderCapabilities;

  generate(apiKey: string, apiUrl: string, request: GenerationRequest): Promise<GenerationResponse>;

  generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown>;

  validateKey(apiKey: string, apiUrl: string, options?: ProviderConnectionOptions): Promise<boolean>;

  listModels(apiKey: string, apiUrl: string, options?: ProviderConnectionOptions): Promise<string[]>;
}
