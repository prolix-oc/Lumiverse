import type { LlmMessage } from "../../../llm/types";
import type { DW_DRAFT_V1 } from "../../../types/dream-weaver";
import { quietGenerate } from "../../generate.service";

export interface SuggestVisualTagsInput {
  userId: string;
  connectionId?: string | null;
  draft: DW_DRAFT_V1;
}

function compactText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .trim();
}

function normalizeEvidenceLines(value: string): string[] {
  return stripMarkdown(value)
    .split(/\n+/)
    .map((line) => compactText(line))
    .filter(Boolean);
}

function buildAppearanceDataSummary(draft: DW_DRAFT_V1): string {
  const entries = Object.entries(draft.card.appearance_data ?? {})
    .map(([key, value]) => {
      const normalizedValue = compactText(value);
      return normalizedValue ? `${key}: ${normalizedValue}` : "";
    })
    .filter(Boolean);

  return entries.join("\n");
}

function parseAppearanceSections(appearance: string): Array<{ key: string; value: string }> {
  return normalizeEvidenceLines(appearance)
    .map((line) => {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (!match) return null;
      return {
        key: compactText(match[1]).toLowerCase(),
        value: compactText(match[2]),
      };
    })
    .filter((entry): entry is { key: string; value: string } => Boolean(entry?.key && entry.value));
}

function extractSeedTagsFromValue(value: string, suffix?: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => compactText(part))
    .filter(Boolean)
    .map((part) => {
      if (!suffix) return part;
      if (part.toLowerCase().includes(suffix.toLowerCase())) return part;
      return `${part} ${suffix}`;
    });
}

function summarizeRoleEvidence(draft: DW_DRAFT_V1): string {
  return [
    compactText(draft.meta.title),
    compactText(draft.meta.summary),
    compactText(draft.card.description),
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeSceneEvidence(draft: DW_DRAFT_V1): string {
  return [
    compactText(draft.card.scenario),
    compactText(draft.greetings[0]?.content),
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeVisualPersonalityEvidence(draft: DW_DRAFT_V1): string {
  return compactText(draft.card.personality);
}

export function buildRoleFactSummary(draft: DW_DRAFT_V1): string {
  return summarizeRoleEvidence(draft) || "None";
}

export function buildSceneFactSummary(draft: DW_DRAFT_V1): string {
  return summarizeSceneEvidence(draft) || "None";
}

export function buildDeterministicTagSeed(draft: DW_DRAFT_V1): string[] {
  const tags = new Set<string>();

  tags.add("masterpiece");
  tags.add("best quality");
  tags.add("newest");

  if (draft.kind === "character") {
    tags.add("1girl");
    tags.add("solo");
    tags.add("looking_at_viewer");
    tags.add("portrait");
  }

  for (const [key, value] of Object.entries(draft.card.appearance_data ?? {})) {
    const normalizedKey = key.toLowerCase();
    for (const tag of extractSeedTagsFromValue(value)) {
      if (normalizedKey === "hair") tags.add(tag.includes("hair") ? tag : `${tag} hair`);
      else if (normalizedKey === "eyes") tags.add(tag.includes("eyes") ? tag : `${tag} eyes`);
      else tags.add(tag);
    }
  }

  for (const section of parseAppearanceSections(draft.card.appearance)) {
    if (section.key.includes("hair")) {
      for (const tag of extractSeedTagsFromValue(section.value, "hair")) tags.add(tag);
    } else if (section.key.includes("eye")) {
      for (const tag of extractSeedTagsFromValue(section.value, "eyes")) tags.add(tag);
    } else if (
      section.key.includes("build") ||
      section.key.includes("body") ||
      section.key.includes("skin") ||
      section.key.includes("height") ||
      section.key.includes("age")
    ) {
      for (const tag of extractSeedTagsFromValue(section.value)) tags.add(tag);
    }
  }

  return [...tags].slice(0, 18);
}

function buildTagSuggestionMessages(draft: DW_DRAFT_V1): LlmMessage[] {
  const appearanceData = buildAppearanceDataSummary(draft) || "None";
  const appearance = stripMarkdown(draft.card.appearance) || "None";
  const roleFacts = buildRoleFactSummary(draft);
  const sceneFacts = buildSceneFactSummary(draft);
  const visualPersonality = summarizeVisualPersonalityEvidence(draft) || "None";
  const deterministicSeed = buildDeterministicTagSeed(draft).join(", ");

  return [
    {
      role: "system",
      content: [
        "You generate image-model tags for character portrait prompts.",
        "Return only one comma-separated tag list.",
        "No prose. No explanations. No markdown. No numbering. No labels.",
        "Output only concrete visual tags that image models can use.",
        "Rank the evidence exactly like this:",
        "1. direct appearance facts",
        "2. role and title context",
        "3. scene context",
        "4. personality only when it affects visible expression, posture, or mood",
        "Appearance facts override everything else.",
        "Role or scene context may influence attire or setting only when they do not conflict with direct appearance facts.",
        "Do not invent casual modern clothing unless the evidence explicitly supports it.",
        "Do not invent unsupported wardrobe, props, creatures, or scenery.",
        "Do not output abstract literary phrases or roleplay language.",
        "Deduplicate tags and keep the list compact.",
        "Include a short quality baseline such as masterpiece, best quality, newest when appropriate.",
        "A baseline-only answer is invalid.",
        "You must include visible subject or appearance tags from the provided appearance evidence whenever available.",
        "If role or scene evidence is weak, prefer neutral portrait tags instead of guessing specific attire.",
        "Target roughly 14 to 28 tags.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "<visual-evidence>",
        "  <appearance-data priority=\"highest\">",
        appearanceData,
        "  </appearance-data>",
        "  <appearance-summary priority=\"highest\">",
        appearance,
        "  </appearance-summary>",
        "  <role-context priority=\"medium\">",
        roleFacts,
        "  </role-context>",
        "  <scene-context priority=\"medium\">",
        sceneFacts,
        "  </scene-context>",
        "  <visual-personality priority=\"low\">",
        visualPersonality,
        "  </visual-personality>",
        "  <safe-seed priority=\"fallback-only\">",
        deterministicSeed,
        "  </safe-seed>",
        "</visual-evidence>",
      ].join("\n"),
    },
  ];
}

export function normalizeSuggestedTagBlock(content: string): string {
  const normalizedText = content
    .replace(/\r/g, "\n")
    .replace(/^tags:\s*/gim, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .replace(/^\s*\d+[.)]\s*/gm, "")
    .trim();

  const rawParts = normalizedText
    .split(/[\n,]+/)
    .map((part) => compactText(part))
    .filter(Boolean);

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of rawParts) {
    const normalizedTag = part
      .replace(/\s+/g, " ")
      .replace(/^looking at viewer$/i, "looking_at_viewer")
      .replace(/^from side$/i, "from_side")
      .replace(/^upper body$/i, "upper_body")
      .replace(/^full body$/i, "full_body")
      .trim();
    const dedupeKey = normalizedTag.toLowerCase();
    if (!normalizedTag || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tags.push(normalizedTag);
  }

  return tags.join(", ");
}

export async function suggestVisualTags(
  input: SuggestVisualTagsInput,
): Promise<{ suggestedTags: string }> {
  const deterministicSeed = buildDeterministicTagSeed(input.draft);
  const response = await quietGenerate(input.userId, {
    connection_id: input.connectionId ?? undefined,
    messages: buildTagSuggestionMessages(input.draft),
    parameters: {
      temperature: 0.35,
      max_tokens: 240,
    },
  });

  const suggestedTags = normalizeSuggestedTagBlock(response.content);
  const suggestedList = suggestedTags
    .split(",")
    .map((tag) => compactText(tag))
    .filter(Boolean);

  const nonBaselineTags = suggestedList.filter(
    (tag) => !["masterpiece", "best quality", "newest", "very aesthetic"].includes(tag.toLowerCase()),
  );

  if (!suggestedTags || nonBaselineTags.length < 3) {
    return { suggestedTags: deterministicSeed.join(", ") };
  }

  return { suggestedTags };
}
