import type { WeaverVisualProvider } from "../../../types/weaver";
import type { VisualProviderAdapter } from "./provider-adapter";
import { comfyUIProviderAdapter } from "./providers/comfyui-provider-adapter";
import { createSimpleProviderAdapter } from "./providers/simple-provider-adapter";
import { swarmUIProviderAdapter } from "./providers/swarmui-provider-adapter";

const adapters = new Map<WeaverVisualProvider, VisualProviderAdapter>([
  ["novelai", createSimpleProviderAdapter("novelai")],
  ["nanogpt", createSimpleProviderAdapter("nanogpt")],
  ["google_gemini", createSimpleProviderAdapter("google_gemini")],
  ["sdapi", createSimpleProviderAdapter("sdapi")],
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
