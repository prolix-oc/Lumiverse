import type { DreamWeaverVisualProvider } from "../../../types/dream-weaver";
import type { VisualProviderAdapter } from "./provider-adapter";
import { comfyUIProviderAdapter } from "./providers/comfyui-provider-adapter";
import { createSimpleProviderAdapter } from "./providers/simple-provider-adapter";

const adapters = new Map<DreamWeaverVisualProvider, VisualProviderAdapter>([
  ["novelai", createSimpleProviderAdapter("novelai")],
  ["nanogpt", createSimpleProviderAdapter("nanogpt")],
  ["google_gemini", createSimpleProviderAdapter("google_gemini")],
  ["swarmui", createSimpleProviderAdapter("swarmui")],
  ["comfyui", comfyUIProviderAdapter],
]);

export function getVisualProviderAdapter(
  provider: DreamWeaverVisualProvider,
): VisualProviderAdapter | undefined {
  return adapters.get(provider);
}

export function listVisualProviderAdapters(): VisualProviderAdapter[] {
  return [...adapters.values()];
}
