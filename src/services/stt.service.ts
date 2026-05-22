import * as secretsSvc from "./secrets.service";
import * as sttConnectionsSvc from "./stt-connections.service";

/** Secret key pattern for LLM connections (matches connections.service.ts) */
function connectionSecretKey(id: string): string {
  return sttConnectionsSvc.sttConnectionSecretKey(id);
}

export interface TranscribeInput {
  audioData: ArrayBuffer;
  fileName: string;
  model?: string;
  language?: string;
  /** STT connection ID whose API key to use */
  connectionId?: string;
}

export interface TranscribeResult {
  text: string;
  language?: string;
}

function normalizeWhisperLanguageCode(language?: string): string | undefined {
  const raw = language?.trim().toLowerCase();
  if (!raw) return undefined;

  // The frontend stores browser/Web Speech locales (en-US, pt-BR, zh-CN),
  // while Whisper/OpenAI-compatible transcription APIs expect ISO language IDs.
  const aliases: Record<string, string> = {
    "en-us": "en",
    "en-gb": "en",
    "ja-jp": "ja",
    "zh-cn": "zh",
    "es-es": "es",
    "fr-fr": "fr",
    "de-de": "de",
    "it-it": "it",
    "pt-br": "pt",
    "ko-kr": "ko",
    "ru-ru": "ru",
  };

  return aliases[raw] || raw.split("-")[0];
}

export async function transcribe(userId: string, input: TranscribeInput): Promise<TranscribeResult> {
  if (!input.connectionId) {
    throw new Error("No connection ID provided for STT — configure an STT connection in Voice settings");
  }

  const profile = sttConnectionsSvc.getConnection(userId, input.connectionId);
  if (!profile) {
    throw new Error("Selected STT connection was not found");
  }

  const provider = sttConnectionsSvc.getProvider(profile.provider);
  if (!provider) {
    throw new Error(`Unknown STT provider: ${profile.provider}`);
  }

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(input.connectionId));
  if (!apiKey) {
    throw new Error("No API key found for the selected connection");
  }

  const model = input.model?.trim() || (await sttConnectionsSvc.resolveConnectionModel(provider, profile, apiKey));

  const formData = new FormData();
  formData.append("file", new Blob([input.audioData]), input.fileName);
  formData.append("model", model);
  const language = normalizeWhisperLanguageCode(input.language);
  if (language) {
    formData.append("language", language);
  }

  const res = await fetch(`${sttConnectionsSvc.resolveSttApiUrl(profile)}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "Unknown error");
    throw new Error(`STT error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  return {
    text: data.text || "",
    language: data.language,
  };
}
