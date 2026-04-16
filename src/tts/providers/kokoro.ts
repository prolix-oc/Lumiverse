import type { TtsProviderCapabilities } from "../param-schema";
import { OpenAICompatibleTtsProvider } from "./openai-compatible-tts";

export class KokoroTtsProvider extends OpenAICompatibleTtsProvider {
  readonly name = "kokoro";
  readonly displayName = "Kokoro TTS";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: {
      speed: {
        type: "number",
        default: 1.0,
        min: 0.5,
        max: 2.0,
        step: 0.1,
        description: "Playback speed multiplier",
      },
    },
    apiKeyRequired: false,
    voiceListStyle: "static",
    staticVoices: [
      // American English — Female
      { id: "af_heart", name: "Heart", language: "en-US", gender: "female" },
      { id: "af_alloy", name: "Alloy", language: "en-US", gender: "female" },
      { id: "af_aoede", name: "Aoede", language: "en-US", gender: "female" },
      { id: "af_bella", name: "Bella", language: "en-US", gender: "female" },
      { id: "af_jessica", name: "Jessica", language: "en-US", gender: "female" },
      { id: "af_kore", name: "Kore", language: "en-US", gender: "female" },
      { id: "af_nicole", name: "Nicole", language: "en-US", gender: "female" },
      { id: "af_nova", name: "Nova", language: "en-US", gender: "female" },
      { id: "af_river", name: "River", language: "en-US", gender: "female" },
      { id: "af_sarah", name: "Sarah", language: "en-US", gender: "female" },
      { id: "af_sky", name: "Sky", language: "en-US", gender: "female" },
      // American English — Male
      { id: "am_adam", name: "Adam", language: "en-US", gender: "male" },
      { id: "am_echo", name: "Echo", language: "en-US", gender: "male" },
      { id: "am_eric", name: "Eric", language: "en-US", gender: "male" },
      { id: "am_liam", name: "Liam", language: "en-US", gender: "male" },
      { id: "am_michael", name: "Michael", language: "en-US", gender: "male" },
      { id: "am_onyx", name: "Onyx", language: "en-US", gender: "male" },
      { id: "am_puck", name: "Puck", language: "en-US", gender: "male" },
      { id: "am_santa", name: "Santa", language: "en-US", gender: "male" },
      // British English
      { id: "bf_alice", name: "Alice", language: "en-GB", gender: "female" },
      { id: "bf_emma", name: "Emma", language: "en-GB", gender: "female" },
      { id: "bf_lily", name: "Lily", language: "en-GB", gender: "female" },
      { id: "bm_daniel", name: "Daniel", language: "en-GB", gender: "male" },
      { id: "bm_fable", name: "Fable", language: "en-GB", gender: "male" },
      { id: "bm_george", name: "George", language: "en-GB", gender: "male" },
      { id: "bm_lewis", name: "Lewis", language: "en-GB", gender: "male" },
      // Japanese
      { id: "jf_alpha", name: "Alpha", language: "ja", gender: "female" },
      { id: "jf_gongitsune", name: "Gongitsune", language: "ja", gender: "female" },
      { id: "jf_nezumi", name: "Nezumi", language: "ja", gender: "female" },
      { id: "jf_tebukuro", name: "Tebukuro", language: "ja", gender: "female" },
      { id: "jm_kumo", name: "Kumo", language: "ja", gender: "male" },
      // Mandarin Chinese
      { id: "zf_xiaobei", name: "Xiaobei", language: "zh", gender: "female" },
      { id: "zf_xiaoni", name: "Xiaoni", language: "zh", gender: "female" },
      { id: "zf_xiaoxuan", name: "Xiaoxuan", language: "zh", gender: "female" },
      { id: "zm_yunjian", name: "Yunjian", language: "zh", gender: "male" },
      { id: "zm_yunxi", name: "Yunxi", language: "zh", gender: "male" },
      { id: "zm_yunxia", name: "Yunxia", language: "zh", gender: "male" },
      { id: "zm_yunyang", name: "Yunyang", language: "zh", gender: "male" },
      // Spanish
      { id: "ef_dora", name: "Dora", language: "es", gender: "female" },
      { id: "em_alex", name: "Alex", language: "es", gender: "male" },
      { id: "em_santa", name: "Santa", language: "es", gender: "male" },
      // French
      { id: "ff_siwis", name: "Siwis", language: "fr", gender: "female" },
      // Hindi
      { id: "hf_alpha", name: "Alpha", language: "hi", gender: "female" },
      { id: "hf_beta", name: "Beta", language: "hi", gender: "female" },
      { id: "hm_omega", name: "Omega", language: "hi", gender: "male" },
      { id: "hm_psi", name: "Psi", language: "hi", gender: "male" },
      // Italian
      { id: "if_sara", name: "Sara", language: "it", gender: "female" },
      { id: "im_nicola", name: "Nicola", language: "it", gender: "male" },
      // Brazilian Portuguese
      { id: "pf_dora", name: "Dora", language: "pt-BR", gender: "female" },
      { id: "pm_alex", name: "Alex", language: "pt-BR", gender: "male" },
      { id: "pm_santa", name: "Santa", language: "pt-BR", gender: "male" },
    ],
    modelListStyle: "static",
    staticModels: [{ id: "kokoro", label: "Kokoro" }],
    supportsStreaming: true,
    supportedFormats: ["mp3", "opus", "wav", "flac"],
    defaultUrl: "http://localhost:8880/v1",
    defaultFormat: "mp3",
  };

  override async validateKey(_apiKey: string, apiUrl: string): Promise<boolean> {
    // Kokoro is self-hosted with no API key — just check reachability
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "kokoro", input: "test", voice: "af_heart" }),
        signal: AbortSignal.timeout(5000),
      });
      // 200 or 400 (bad request) both indicate reachability
      return res.status < 500;
    } catch {
      return false;
    }
  }
}
