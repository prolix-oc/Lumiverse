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
  kind?: "bytes" | "audio_file";
  mimeType?: string;
}

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  description?: string;
  previewUrl?: string;
}

export interface TtsLibraryVoice extends TtsVoice {
  accent?: string;
  age?: string;
  useCase?: string;
  rate?: number;
  noticePeriod?: number;
  liveModeration?: boolean;
}

export interface TtsVoiceLibraryOptions {
  page?: number;
  page_size?: number;
  search?: string;
  language?: string;
  gender?: "male" | "female" | "neutral";
  sort?: "trending" | "created_date" | "cloned_by_count" | "usage_character_count_1y";
}

export interface TtsVoiceLibraryResult {
  voices: TtsLibraryVoice[];
  has_more: boolean;
  total_count?: number;
}
