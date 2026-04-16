import * as secretsSvc from "./secrets.service";

/** Secret key pattern for LLM connections (matches connections.service.ts) */
function connectionSecretKey(id: string): string {
  return `connection_${id}_api_key`;
}

export interface TranscribeInput {
  audioData: ArrayBuffer;
  fileName: string;
  model?: string;
  language?: string;
  /** LLM connection ID whose OpenAI API key to use */
  connectionId?: string;
}

export interface TranscribeResult {
  text: string;
  language?: string;
}

export async function transcribe(userId: string, input: TranscribeInput): Promise<TranscribeResult> {
  if (!input.connectionId) {
    throw new Error("No connection ID provided for STT — configure an OpenAI connection in Voice settings");
  }

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(input.connectionId));
  if (!apiKey) {
    throw new Error("No API key found for the selected connection");
  }

  const formData = new FormData();
  formData.append("file", new Blob([input.audioData]), input.fileName);
  formData.append("model", input.model || "gpt-4o-transcribe");
  if (input.language) {
    formData.append("language", input.language);
  }

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "Unknown error");
    throw new Error(`OpenAI STT error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  return {
    text: data.text || "",
    language: data.language,
  };
}
