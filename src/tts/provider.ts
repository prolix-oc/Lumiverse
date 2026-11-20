import type { TtsProviderCapabilities } from "./param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk, TtsVoice, TtsVoiceLibraryOptions, TtsVoiceLibraryResult } from "./types";

export interface TtsVoiceListOptions {
  /** Selected model id when a provider exposes model-specific voices. */
  model?: string;
}

export interface TtsProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: TtsProviderCapabilities;

  synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse>;

  synthesizeStream(apiKey: string, apiUrl: string, request: TtsRequest): AsyncGenerator<TtsStreamChunk, void, unknown>;

  validateKey(apiKey: string, apiUrl: string): Promise<boolean>;

  listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>>;

  listVoices(apiKey: string, apiUrl: string, options?: TtsVoiceListOptions): Promise<TtsVoice[]>;

  listVoiceLibrary?(apiKey: string, apiUrl: string, options: TtsVoiceLibraryOptions): Promise<TtsVoiceLibraryResult>;
}
