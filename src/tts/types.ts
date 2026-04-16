export interface TtsRequest {
  text: string;
  model: string;
  voice: string;
  parameters: Record<string, any>;
  outputFormat?: string;
  signal?: AbortSignal;
}

export interface TtsResponse {
  audioData: ArrayBuffer;
  contentType: string;
  model: string;
  provider: string;
}

export interface TtsStreamChunk {
  data: Uint8Array;
  done: boolean;
}

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  previewUrl?: string;
}
