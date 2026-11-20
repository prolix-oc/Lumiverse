import type { TtsRequest, TtsStreamChunk, TtsVoice } from "../types";

/** Gemini text-to-speech models. TTS-only list: no text/generation models. */
export const GOOGLE_TTS_MODELS: Array<{ id: string; label: string }> = [
  { id: "gemini-3.1-flash-tts-preview", label: "Gemini 3.1 Flash TTS (legacy)" },
  { id: "gemini-2.5-pro-preview-tts", label: "Gemini 2.5 Pro TTS (high quality)" },
  { id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash Lite TTS (fast)" },
  { id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS (latest)" },
];

/** Keep a model ID only when it names a speech/TTS model. */
export function isTtsModelId(id: string): boolean {
  return /(?:^|[-_./: ])(tts|speech)(?:$|[-_./: ])/i.test(id);
}

/**
 * Prebuilt Gemini voices, mapped to readable names with documented gender.
 * IDs are the API voice names; `language` marks the documented voice locale.
 * Gender: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts#voice_options
 * Tone descriptions paraphrase Google's voice style labels:
 * https://ai.google.dev/gemini-api/docs/speech-generation#voice_options
 */
export const GOOGLE_TTS_VOICES = [
  { id: "Achird", name: "Achird", language: "en-US", gender: "masculine", description: "Friendly, approachable delivery." },
  { id: "Achernar", name: "Achernar", language: "en-US", gender: "feminine", description: "Soft, delicate delivery." },
  { id: "Algenib", name: "Algenib", language: "en-US", gender: "masculine", description: "Gravelly, textured voice." },
  { id: "Algieba", name: "Algieba", language: "en-US", gender: "masculine", description: "Smooth, flowing delivery." },
  { id: "Alnilam", name: "Alnilam", language: "en-US", gender: "masculine", description: "Firm, steady delivery." },
  { id: "Aoede", name: "Aoede", language: "en-US", gender: "feminine", description: "Breezy, relaxed delivery." },
  { id: "Autonoe", name: "Autonoe", language: "en-US", gender: "feminine", description: "Bright, buoyant tone." },
  { id: "Callirrhoe", name: "Callirrhoe", language: "en-US", gender: "feminine", description: "Easygoing, relaxed delivery." },
  { id: "Charon", name: "Charon", language: "en-US", gender: "masculine", description: "Informative, explanatory delivery." },
  { id: "Despina", name: "Despina", language: "en-US", gender: "feminine", description: "Smooth, flowing delivery." },
  { id: "Enceladus", name: "Enceladus", language: "en-US", gender: "masculine", description: "Breathy, airy voice." },
  { id: "Erinome", name: "Erinome", language: "en-US", gender: "feminine", description: "Clear, articulate delivery." },
  { id: "Fenrir", name: "Fenrir", language: "en-US", gender: "masculine", description: "Excitable, animated tone." },
  { id: "Gacrux", name: "Gacrux", language: "en-US", gender: "feminine", description: "Mature, seasoned tone." },
  { id: "Iapetus", name: "Iapetus", language: "en-US", gender: "masculine", description: "Clear, articulate delivery." },
  { id: "Kore", name: "Kore", language: "en-US", gender: "feminine", description: "Firm, assured delivery." },
  { id: "Laomedeia", name: "Laomedeia", language: "en-US", gender: "feminine", description: "Upbeat, cheerful tone." },
  { id: "Leda", name: "Leda", language: "en-US", gender: "feminine", description: "Youthful, light tone." },
  { id: "Orus", name: "Orus", language: "en-US", gender: "masculine", description: "Firm, assured delivery." },
  { id: "Pulcherrima", name: "Pulcherrima", language: "en-US", gender: "feminine", description: "Forward, direct delivery." },
  { id: "Puck", name: "Puck", language: "en-US", gender: "masculine", description: "Upbeat, cheerful tone." },
  { id: "Rasalgethi", name: "Rasalgethi", language: "en-US", gender: "masculine", description: "Informative, explanatory delivery." },
  { id: "Sadachbia", name: "Sadachbia", language: "en-US", gender: "masculine", description: "Lively, spirited tone." },
  { id: "Sadaltager", name: "Sadaltager", language: "en-US", gender: "masculine", description: "Knowledgeable, considered delivery." },
  { id: "Schedar", name: "Schedar", language: "en-US", gender: "masculine", description: "Even, balanced delivery." },
  { id: "Sulafat", name: "Sulafat", language: "en-US", gender: "feminine", description: "Warm, welcoming tone." },
  { id: "Umbriel", name: "Umbriel", language: "en-US", gender: "masculine", description: "Easygoing, relaxed delivery." },
  { id: "Vindemiatrix", name: "Vindemiatrix", language: "en-US", gender: "feminine", description: "Gentle, soft delivery." },
  { id: "Zephyr", name: "Zephyr", language: "en-US", gender: "feminine", description: "Bright, buoyant tone." },
  { id: "Zubenelgenubi", name: "Zubenelgenubi", language: "en-US", gender: "masculine", description: "Casual, conversational delivery." },
] satisfies TtsVoice[];

export const DEFAULT_GEMINI_TTS_SPEECH_STYLE =
  "casual, relaxed conversation, natural pacing, understated expression";

export const GEMINI_TTS_SPEECH_STYLE_PARAMETER = {
  type: "string" as const,
  default: DEFAULT_GEMINI_TTS_SPEECH_STYLE,
  description: "Brief delivery guidance for Gemini 3.8 TTS. Defaults to relaxed conversation; clear it to use the voice's usual delivery.",
  group: "advanced",
};

/** Gemini 3.8 uses per-part metadata instead of spoken prompt instructions. */
export function resolveGeminiTtsSpeechStyle(request: Pick<TtsRequest, "model" | "parameters">): string | undefined {
  if (!/(?:^|\/)gemini-3\.8-flash(?:-lite)?-tts(?:$|[-:])/i.test(request.model)) return undefined;
  const configured = request.parameters.speech_style ?? request.parameters.instructions;
  return typeof configured === "string"
    ? configured.trim() || undefined
    : DEFAULT_GEMINI_TTS_SPEECH_STYLE;
}

export const GOOGLE_TTS_PARAMETERS = {
  speech_style: GEMINI_TTS_SPEECH_STYLE_PARAMETER,
  language_code: {
    type: "string" as const,
    description: "BCP-47 language code for synthesis (e.g. en-US). Leave blank for the default.",
    group: "advanced",
  },
  temperature: {
    type: "number" as const,
    default: 1,
    min: 0,
    max: 2,
    step: 0.05,
    description: "Voice variation — higher values add expressiveness, lower values are more deterministic",
    group: "advanced",
  },
};

/** Single-speaker generateContent body requesting AUDIO output. */
export function buildGeminiTtsBody(request: TtsRequest): Record<string, any> {
  const speechConfig: Record<string, any> = {
    voice_config: {
      prebuilt_voice_config: { voice_name: request.voice },
    },
  };
  if (typeof request.parameters.language_code === "string" && request.parameters.language_code.trim()) {
    speechConfig.language_code = request.parameters.language_code.trim();
  }
  const generationConfig: Record<string, any> = {
    responseModalities: ["AUDIO"],
    speech_config: speechConfig,
  };
  if (typeof request.parameters.temperature === "number") {
    generationConfig.temperature = request.parameters.temperature;
  }
  const part: Record<string, any> = { text: request.text };
  const style = resolveGeminiTtsSpeechStyle(request);
  if (style) part.speech_metadata = { style };
  return {
    contents: [{ role: "user", parts: [part] }],
    generationConfig,
  };
}

function parsePcmRate(mimeType: string | undefined): number {
  const match = /rate=(\d+)/i.exec(mimeType || "");
  const rate = match ? Number.parseInt(match[1], 10) : 24000;
  return Number.isFinite(rate) && rate > 0 ? rate : 24000;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Wrap raw 16-bit PCM in a WAV container so browsers can play it. */
export function wrapPcmInWav(pcm: Uint8Array, sampleRate: number, channels = 1): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out.buffer;
}

function decodeGeminiTtsAudio(base64: string, mimeType: string | undefined): ArrayBuffer {
  const bytes = base64ToBytes(base64);
  const mediaType = (mimeType || "").split(";")[0].trim().toLowerCase();
  const isWav = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"].includes(mediaType)
    || (bytes.length >= 12
      && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE");

  return isWav ? bytes.buffer : wrapPcmInWav(bytes, parsePcmRate(mimeType));
}

/** Extract the first inline audio payload from a generateContent response. */
export function extractGeminiTtsAudio(data: any): { audioData: ArrayBuffer; contentType: string } {
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      const mimeType: string | undefined = inline.mimeType || inline.mime_type;
      const audioData = decodeGeminiTtsAudio(inline.data, mimeType);
      return { audioData, contentType: "audio/wav" };
    }
  }
  throw new Error("No audio payload in Gemini TTS response");
}

/** Extract inline audio payloads from a candidate part. */
export function* extractGeminiTtsAudioChunks(data: any): Generator<TtsStreamChunk, void, unknown> {
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      const mimeType: string | undefined = inline.mimeType || inline.mime_type;
      const audioData = decodeGeminiTtsAudio(inline.data, mimeType);
      yield {
        data: new Uint8Array(audioData),
        done: false,
        kind: "audio_file",
        mimeType: "audio/wav",
      };
    }
  }
}

/** Consume an SSE response from Gemini streamGenerateContent and yield audio WAV chunks. */
export async function* streamGeminiTtsAudio(
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<TtsStreamChunk, void, unknown> {
  if (!res.body) {
    throw new Error("No response body for streaming");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedAny = false;

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const data = JSON.parse(payload);
          for (const chunk of extractGeminiTtsAudioChunks(data)) {
            emittedAny = true;
            yield chunk;
          }
        } catch {
          // Ignore unparseable line
        }
      }
    }

    buffer += decoder.decode().replace(/\r/g, "");
    if (buffer.trim().startsWith("data: ")) {
      const payload = buffer.trim().slice(6).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const data = JSON.parse(payload);
          for (const chunk of extractGeminiTtsAudioChunks(data)) {
            emittedAny = true;
            yield chunk;
          }
        } catch {}
      }
    }

    if (!emittedAny) {
      throw new Error("No audio payload in Gemini TTS stream");
    }

    yield {
      data: new Uint8Array(0),
      done: true,
      kind: "audio_file",
      mimeType: "audio/wav",
    };
  } finally {
    reader.cancel().catch(() => {});
  }
}
