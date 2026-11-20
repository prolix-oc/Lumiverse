import type { WeaverVisualProvider } from "../../../types/weaver";
import type { VisualProviderAdapter } from "./provider-adapter";
import { comfyUIProviderAdapter } from "./providers/comfyui-provider-adapter";
import { createSimpleProviderAdapter } from "./providers/simple-provider-adapter";
import { swarmUIProviderAdapter } from "./providers/swarmui-provider-adapter";

const adapters = new Map<WeaverVisualProvider, VisualProviderAdapter>([
  ["novelai", createSimpleProviderAdapter("novelai")],
  ["nanogpt", createSimpleProviderAdapter("nanogpt")],
  ["google_gemini", createSimpleProviderAdapter("google_gemini")],
  ["openrouter", createSimpleProviderAdapter("openrouter")],
  ["sdapi", createSimpleProviderAdapter("sdapi")],
  ["openai", createSimpleProviderAdapter("openai")],
  ["pollinations", createSimpleProviderAdapter("pollinations")],
  ["custom_openai", createSimpleProviderAdapter("custom_openai")],
  ["together", createSimpleProviderAdapter("together")],
  ["xai", createSimpleProviderAdapter("xai")],
  ["venice", createSimpleProviderAdapter("venice")],
  ["venice_compat", createSimpleProviderAdapter("venice_compat")],
  ["recraft", createSimpleProviderAdapter("recraft")],
  ["deepinfra", createSimpleProviderAdapter("deepinfra")],
  ["ideogram", createSimpleProviderAdapter("ideogram")],
  ["fireworks", createSimpleProviderAdapter("fireworks")],
  ["stability", createSimpleProviderAdapter("stability")],
  ["bfl", createSimpleProviderAdapter("bfl")],
  ["fal", createSimpleProviderAdapter("fal")],
  ["replicate", createSimpleProviderAdapter("replicate")],
  ["leonardo", createSimpleProviderAdapter("leonardo")],
  ["runware", createSimpleProviderAdapter("runware")],
  ["civitai", createSimpleProviderAdapter("civitai")],
  ["civitai_chat", createSimpleProviderAdapter("civitai_chat")],
  ["huggingface", createSimpleProviderAdapter("huggingface")],
  ["swarmui", swarmUIProviderAdapter],
  ["comfyui", comfyUIProviderAdapter],
]);

export function getVisualProviderAdapter(
  provider: WeaverVisualProvider,
): VisualProviderAdapter | undefined {
  return adapters.get(provider);
}

export function listVisualProviderAdapters(): VisualProviderAdapter[] {
  return [...adapters.values()];
}
