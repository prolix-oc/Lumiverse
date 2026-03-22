import type { GenerationRequest, GenerationResponse, StreamChunk } from "./types";
import type { ProviderCapabilities } from "./param-schema";

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

  validateKey(apiKey: string, apiUrl: string): Promise<boolean>;

  listModels(apiKey: string, apiUrl: string): Promise<string[]>;
}
