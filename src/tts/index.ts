import { registerTtsProvider } from "./registry";
import { OpenAITtsProvider } from "./providers/openai-tts";
import { ElevenLabsTtsProvider } from "./providers/elevenlabs";
import { KokoroTtsProvider } from "./providers/kokoro";

registerTtsProvider(new OpenAITtsProvider());
registerTtsProvider(new ElevenLabsTtsProvider());
registerTtsProvider(new KokoroTtsProvider());
