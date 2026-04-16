import { getTtsProvider } from "../tts/registry";
import * as ttsConnSvc from "./tts-connections.service";
import * as secretsSvc from "./secrets.service";
import type { TtsRequest, TtsResponse, TtsStreamChunk } from "../tts/types";

export interface SynthesizeInput {
  connectionId?: string;
  text: string;
  voice?: string;
  model?: string;
  parameters?: Record<string, any>;
  outputFormat?: string;
}

function resolveConnection(userId: string, connectionId?: string) {
  const profile = connectionId
    ? ttsConnSvc.getConnection(userId, connectionId)
    : ttsConnSvc.getDefaultConnection(userId);

  if (!profile) {
    throw new Error(connectionId ? `TTS connection not found: ${connectionId}` : "No default TTS connection configured");
  }
  return profile;
}

export async function synthesize(userId: string, input: SynthesizeInput): Promise<TtsResponse> {
  const profile = resolveConnection(userId, input.connectionId);

  const provider = getTtsProvider(profile.provider);
  if (!provider) throw new Error(`Unknown TTS provider: ${profile.provider}`);

  const apiKey = await secretsSvc.getSecret(userId, ttsConnSvc.ttsConnectionSecretKey(profile.id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    throw new Error(`No API key for TTS connection "${profile.name}"`);
  }

  const request: TtsRequest = {
    text: input.text,
    model: input.model || profile.model,
    voice: input.voice || profile.voice,
    parameters: { ...profile.default_parameters, ...input.parameters },
    outputFormat: input.outputFormat || profile.default_parameters.output_format,
  };

  return provider.synthesize(apiKey || "", profile.api_url || "", request);
}

export async function* synthesizeStream(
  userId: string,
  input: SynthesizeInput
): AsyncGenerator<TtsStreamChunk, void, unknown> {
  const profile = resolveConnection(userId, input.connectionId);

  const provider = getTtsProvider(profile.provider);
  if (!provider) throw new Error(`Unknown TTS provider: ${profile.provider}`);

  if (!provider.capabilities.supportsStreaming) {
    throw new Error(`Provider "${provider.displayName}" does not support streaming`);
  }

  const apiKey = await secretsSvc.getSecret(userId, ttsConnSvc.ttsConnectionSecretKey(profile.id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    throw new Error(`No API key for TTS connection "${profile.name}"`);
  }

  const request: TtsRequest = {
    text: input.text,
    model: input.model || profile.model,
    voice: input.voice || profile.voice,
    parameters: { ...profile.default_parameters, ...input.parameters },
    outputFormat: input.outputFormat || profile.default_parameters.output_format,
  };

  yield* provider.synthesizeStream(apiKey || "", profile.api_url || "", request);
}
