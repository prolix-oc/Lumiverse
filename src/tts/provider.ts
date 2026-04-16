import type { TtsProviderCapabilities } from "./param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice } from "./types";

export interface TtsProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: TtsProviderCapabilities;

  synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse>;

  synthesizeStream(apiKey: string, apiUrl: string, request: TtsRequest): AsyncGenerator<TtsStreamChunk, void, unknown>;

  validateKey(apiKey: string, apiUrl: string): Promise<boolean>;

  listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>>;

  listVoices(apiKey: string, apiUrl: string): Promise<TtsVoice[]>;
}
