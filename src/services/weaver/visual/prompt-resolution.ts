import type { WeaverVisualAsset } from "../../../types/weaver";

export function resolveVisualPrompt(
  prompt: string,
  values: Record<string, string | undefined>,
): string {
  return prompt.replace(/\{\{([\w.]+)\}\}/g, (fullMatch, tokenName: string) => {
    const normalized = tokenName.trim();
    if (!normalized) return fullMatch;
    const value = values[normalized];
    return typeof value === "string" ? value : fullMatch;
  });
}

export function resolveVisualAssetPrompts(
  asset: WeaverVisualAsset,
  values: Record<string, string | undefined>,
): WeaverVisualAsset {
  return {
    ...asset,
    prompt: resolveVisualPrompt(asset.prompt, values),
    negative_prompt: resolveVisualPrompt(asset.negative_prompt, values),
  };
}
