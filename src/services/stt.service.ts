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

export async function transcribe(userId: string, input: TranscribeInput): Promise<TranscribeResult> {
  if (!input.connectionId) {
    throw new Error("No connection ID provided for STT — configure an STT connection in Voice settings");
  }

  const profile = sttConnectionsSvc.getConnection(userId, input.connectionId);
  if (!profile) {
    throw new Error("Selected STT connection was not found");
  }

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(input.connectionId));
  if (!apiKey) {
    throw new Error("No API key found for the selected connection");
  }

  const formData = new FormData();
  formData.append("file", new Blob([input.audioData]), input.fileName);
  formData.append("model", input.model || profile.model || "gpt-4o-transcribe");
  if (input.language) {
    formData.append("language", input.language);
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
