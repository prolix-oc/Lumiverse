import * as secretsSvc from "./secrets.service";
import * as ttsConnectionsSvc from "./tts-connections.service";
import {
  QWEN_TTS_PROVIDER,
  qwenApiBaseUrl,
  qwenPromptVoiceId,
  readQwenCustomVoices,
  type QwenCustomVoiceRecord,
  type QwenModelHealth,
  upsertQwenCustomVoice,
  removeQwenCustomVoice,
} from "../tts/providers/qwen3-utils";
import { fetchProviderJson, throwProviderResponseError } from "../utils/provider-errors";

const MAX_QWEN_CLONE_AUDIO_BYTES = 15 * 1024 * 1024;

export interface CreateQwenCustomVoiceInput {
  name: string;
  transcript?: string;
  sourceFilename?: string;
  audioData: Uint8Array;
  xVectorOnlyMode?: boolean;
}

export interface QwenCustomVoiceMutationResult {
  profile: NonNullable<ReturnType<typeof ttsConnectionsSvc.getConnection>>;
  voice: QwenCustomVoiceRecord;
}

function qwenHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };
}

function requireQwenConnection(userId: string, connectionId: string) {
  const profile = ttsConnectionsSvc.getConnection(userId, connectionId);
  if (!profile) {
    throw new Error("TTS connection not found");
  }
  if (profile.provider !== QWEN_TTS_PROVIDER) {
    throw new Error("This TTS connection does not use Qwen3-TTS Server");
  }
  return profile;
}

async function requireQwenApiKey(userId: string, connectionId: string) {
  const apiKey = await secretsSvc.getSecret(userId, ttsConnectionsSvc.ttsConnectionSecretKey(connectionId));
  if (!apiKey) {
    throw new Error("No API key for this Qwen3-TTS Server connection");
  }
  return apiKey;
}

async function readQwenModelHealth(apiUrl: string): Promise<QwenModelHealth> {
  return fetchProviderJson<QwenModelHealth>(
    "Qwen3-TTS Server",
    "model health",
    `${qwenApiBaseUrl(apiUrl)}/health/models`,
    { headers: { Accept: "application/json" } },
  );
}

export function listQwenCustomVoices(userId: string, connectionId: string): QwenCustomVoiceRecord[] {
  const profile = requireQwenConnection(userId, connectionId);
  return readQwenCustomVoices(profile.metadata);
}

export async function createQwenCustomVoice(
  userId: string,
  connectionId: string,
  input: CreateQwenCustomVoiceInput,
): Promise<QwenCustomVoiceMutationResult> {
  const profile = requireQwenConnection(userId, connectionId);
  const apiKey = await requireQwenApiKey(userId, connectionId);

  const name = input.name.trim();
  const transcript = input.transcript?.trim();
  if (!name) throw new Error("Voice name is required");
  if (!input.xVectorOnlyMode && !transcript) {
    throw new Error("Transcript is required unless x-vector-only mode is enabled");
  }
  if (!input.audioData.byteLength) {
    throw new Error("Reference audio is required");
  }
  if (input.audioData.byteLength > MAX_QWEN_CLONE_AUDIO_BYTES) {
    throw new Error(`Reference audio exceeds the ${Math.floor(MAX_QWEN_CLONE_AUDIO_BYTES / (1024 * 1024))} MB limit`);
  }

  const existing = readQwenCustomVoices(profile.metadata);
  if (existing.some((voice) => voice.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`A saved Qwen voice named "${name}" already exists on this connection`);
  }

  const health = await readQwenModelHealth(profile.api_url || "");
  if (!health.base_loaded) {
    throw new Error("The Qwen server does not currently have the base voice-cloning model loaded");
  }

  const res = await fetch(`${qwenApiBaseUrl(profile.api_url || "")}/api/v1/base/create-prompt`, {
    method: "POST",
    headers: qwenHeaders(apiKey),
    body: JSON.stringify({
      ref_text: input.xVectorOnlyMode ? undefined : transcript,
      ref_audio_base64: Buffer.from(input.audioData).toString("base64"),
      x_vector_only_mode: !!input.xVectorOnlyMode,
    }),
  });
  if (!res.ok) await throwProviderResponseError("Qwen3-TTS Server", "voice clone prompt creation", res);

  const payload = await res.json() as { prompt_id?: string };
  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id.trim() : "";
  if (!promptId) {
    throw new Error("Qwen3-TTS Server did not return a prompt_id");
  }

  const voice: QwenCustomVoiceRecord = {
    id: qwenPromptVoiceId(promptId),
    name,
    prompt_id: promptId,
    transcript: transcript || undefined,
    source_filename: input.sourceFilename?.trim() || undefined,
    created_at: Math.floor(Date.now() / 1000),
  };

  const updated = await ttsConnectionsSvc.updateConnection(userId, connectionId, {
    metadata: upsertQwenCustomVoice(profile.metadata, voice),
  });
  if (!updated) {
    throw new Error("TTS connection disappeared while saving the cloned voice");
  }

  return { profile: updated, voice };
}

export async function deleteQwenCustomVoice(
  userId: string,
  connectionId: string,
  voiceId: string,
): Promise<{ success: boolean; profile: NonNullable<ReturnType<typeof ttsConnectionsSvc.getConnection>> | null }> {
  const profile = requireQwenConnection(userId, connectionId);
  const { metadata, deleted } = removeQwenCustomVoice(profile.metadata, voiceId);
  if (!deleted) {
    return { success: false, profile };
  }

  const updated = await ttsConnectionsSvc.updateConnection(userId, connectionId, {
    metadata,
    voice: profile.voice === voiceId ? "" : undefined,
  });
  return { success: true, profile: updated };
}
