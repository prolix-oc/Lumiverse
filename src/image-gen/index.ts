import { registerImageProvider } from "./registry";
import { GoogleGeminiImageProvider } from "./providers/google-gemini";
import { NanoGPTImageProvider } from "./providers/nanogpt";
import { NovelAIImageProvider } from "./providers/novelai";

registerImageProvider(new GoogleGeminiImageProvider());
registerImageProvider(new NanoGPTImageProvider());
registerImageProvider(new NovelAIImageProvider());
