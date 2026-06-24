import { registerTtsProvider } from "./registry";
import { OpenAITtsProvider } from "./providers/openai-tts";
import { ElevenLabsTtsProvider } from "./providers/elevenlabs";
import { KokoroTtsProvider } from "./providers/kokoro";
import { OpenRouterTtsProvider } from "./providers/openrouter-tts";
import { CartesiaTtsProvider } from "./providers/cartesia";

registerTtsProvider(new CartesiaTtsProvider());
registerTtsProvider(new OpenAITtsProvider());
registerTtsProvider(new ElevenLabsTtsProvider());
registerTtsProvider(new KokoroTtsProvider());
registerTtsProvider(new OpenRouterTtsProvider());
