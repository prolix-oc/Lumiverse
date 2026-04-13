import type { DW_DRAFT_V1, DreamWeaverVisualAsset } from "../../../types/dream-weaver";

function buildPromptMacroValues(
  draft: DW_DRAFT_V1 | null | undefined,
): Record<string, string | undefined> {
  if (!draft) return {};

  const values: Record<string, string | undefined> = {
    name: draft.card.name,
    appearance: draft.card.appearance,
    description: draft.card.description,
    personality: draft.card.personality,
    scenario: draft.card.scenario,
  };

  for (const [key, value] of Object.entries(draft.card.appearance_data ?? {})) {
    values[`appearance.${key}`] = value;
  }

  return values;
}

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
  asset: DreamWeaverVisualAsset,
  draft: DW_DRAFT_V1 | null | undefined,
): DreamWeaverVisualAsset {
  const values = buildPromptMacroValues(draft);

  return {
    ...asset,
    prompt: resolveVisualPrompt(asset.prompt, values),
    negative_prompt: resolveVisualPrompt(asset.negative_prompt, values),
  };
}
