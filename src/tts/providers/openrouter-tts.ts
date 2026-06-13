import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsRequest, TtsVoice } from "../types";
import { OpenAICompatibleTtsProvider } from "./openai-compatible-tts";
import { fetchProviderJson } from "../../utils/provider-errors";

/**
 * OpenRouter Text-to-Speech.
 *
 * OpenRouter exposes an OpenAI-compatible `/audio/speech` endpoint, so this
 * reuses {@link OpenAICompatibleTtsProvider} for synthesis/streaming and only
 * overrides model discovery (TTS-capable models are found via the Models API's
 * `output_modalities=speech` filter rather than a name heuristic).
 *
 * Voices are model-specific on OpenRouter (OpenAI, Gemini and Azure/MAI all use
 * different names) and there is no unified voices endpoint. We ship a curated
 * list for the popular models; the voice field is a free-text combobox so any
 * other model's voice id can be entered directly.
 *
 * @see https://openrouter.ai/docs/guides/overview/multimodal/tts
 */
export class OpenRouterTtsProvider extends OpenAICompatibleTtsProvider {
  readonly name = "openrouter_tts";
  readonly displayName = "OpenRouter TTS";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: {
      speed: {
        type: "number",
        default: 1.0,
        min: 0.5,
        max: 2.0,
        step: 0.05,
        description: "Playback speed multiplier (honored by Azure/MAI; ignored by some providers)",
      },
      instructions: {
        type: "string",
        description: "Style instructions (gpt-4o-mini-tts only). E.g. 'Speak warmly with a slight British accent'",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    // Voices vary per model and there's no unified list endpoint — curated list
    // covers the popular models, the combobox allows free-text for the rest.
    voiceListStyle: "static",
    staticVoices: [
      // OpenAI (openai/gpt-4o-mini-tts)
      { id: "alloy", name: "Alloy (OpenAI)" },
      { id: "ash", name: "Ash (OpenAI)" },
      { id: "ballad", name: "Ballad (OpenAI)" },
      { id: "coral", name: "Coral (OpenAI)" },
      { id: "echo", name: "Echo (OpenAI)" },
      { id: "fable", name: "Fable (OpenAI)" },
      { id: "nova", name: "Nova (OpenAI)" },
      { id: "onyx", name: "Onyx (OpenAI)" },
      { id: "sage", name: "Sage (OpenAI)" },
      { id: "shimmer", name: "Shimmer (OpenAI)" },
      // Google (google/gemini-2.5-flash-tts and friends)
      { id: "Zephyr", name: "Zephyr (Gemini)" },
      { id: "Puck", name: "Puck (Gemini)" },
      { id: "Charon", name: "Charon (Gemini)" },
      { id: "Kore", name: "Kore (Gemini)" },
      { id: "Fenrir", name: "Fenrir (Gemini)" },
      { id: "Aoede", name: "Aoede (Gemini)" },
    ],
    modelListStyle: "dynamic",
    supportsStreaming: true,
    // OpenRouter only accepts mp3 or pcm. mp3 is browser-friendly; pcm is lower latency.
    supportedFormats: ["mp3", "pcm"],
    defaultUrl: "https://openrouter.ai/api/v1",
    defaultFormat: "mp3",
  };

  protected override extraHeaders(): Record<string, string> {
    return {
      "HTTP-Referer": "https://lumiverse.chat",
      "X-Title": "Lumiverse",
    };
  }

  protected override buildBody(request: TtsRequest): Record<string, any> {
    const body = super.buildBody(request);
    // `instructions` is only honored by the OpenAI gpt-4o-mini-tts family.
    if (request.parameters.instructions && /gpt-4o-mini-tts/i.test(request.model)) {
      body.instructions = request.parameters.instructions;
    }
    return body;
  }

  /**
   * TTS-capable models on OpenRouter are surfaced via the Models API filtered by
   * `output_modalities=speech`. The generic name-based filter used by the base
   * class misses models like `microsoft/mai-voice-2`, so we override.
   */
  override async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const url = `${this.baseUrl(apiUrl)}/models?output_modalities=speech`;
    const data = await fetchProviderJson<any>(this.displayName, "model listing", url, {
      headers: this.headers(apiKey),
    });
    const models: Array<{ id: string; label: string }> = (data?.data || [])
      .map((m: any) => ({ id: m.id, label: m.name || m.id }))
      .filter((m: { id: string }) => typeof m.id === "string" && m.id.length > 0)
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    return models;
  }

  override async listVoices(_apiKey: string, _apiUrl: string): Promise<TtsVoice[]> {
    return this.capabilities.staticVoices || [];
  }
}
