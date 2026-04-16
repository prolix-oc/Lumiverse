import { registerImageProvider } from "./registry";
import { GoogleGeminiImageProvider } from "./providers/google-gemini";
import { NanoGPTImageProvider } from "./providers/nanogpt";
import { NovelAIImageProvider } from "./providers/novelai";
import { PollinationsImageProvider } from "./providers/pollinations";
import { ComfyUIImageProvider } from "./providers/comfyui";
import { SwarmUIImageProvider } from "./providers/swarmui";

registerImageProvider(new GoogleGeminiImageProvider());
registerImageProvider(new NanoGPTImageProvider());
registerImageProvider(new NovelAIImageProvider());
registerImageProvider(new PollinationsImageProvider());
registerImageProvider(new ComfyUIImageProvider());
registerImageProvider(new SwarmUIImageProvider());
