import type { LlmMessage } from "../../../llm/types";
import type { DW_DRAFT_V1 } from "../../../types/dream-weaver";
import { quietGenerate } from "../../generate.service";

export interface DWTagLlmParams {
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  topK?: number | null;
}

export interface SuggestVisualTagsInput {
  userId: string;
  connectionId?: string | null;
  draft: DW_DRAFT_V1;
  params?: DWTagLlmParams | null;
  signal?: AbortSignal | null;
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

/**
 * Keys in appearance_data that contain non-visual metadata unsuitable as image tags.
 * Values under these keys are skipped entirely in the deterministic seed.
 */
const NON_VISUAL_APPEARANCE_KEYS = new Set([
  "measurements", "measurement", "three sizes", "three_sizes",
  "bust", "waist", "hip", "hips", "chest", "cup", "bra",
  "height", "weight", "bmi",
  "birthday", "birth_date", "birthdate", "date", "age",
  "blood type", "blood_type", "bloodtype",
  "nationality", "race", "ethnicity",
  "occupation", "job", "role",
]);

/**
 * Returns true if a raw value string looks like a measurement, date, or other
 * non-visual literal that should not appear in an image prompt.
 */
function looksLikeMeasurementOrDate(value: string): boolean {
  const v = value.trim();
  // Pure number or number with unit (e.g. "165cm", "5'7\"", "35\"", "58 kg")
  if (/^\d[\d.,'\"\s]*(?:cm|mm|m|kg|lb|lbs|inch|inches|ft|'|")?$/i.test(v)) return true;
  // Comma-separated list of numbers (body measurements like "35, 27, 38")
  if (/^\d+(?:[.,]\d+)?(?:\s*[,/]\s*\d+(?:[.,]\d+)?){1,5}\s*(?:"|cm)?$/.test(v)) return true;
  // Date patterns: "October 12th", "12/10", "Jan 5", "2000-01-01"
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(v)) return true;
  if (/\b\d{1,2}(?:st|nd|rd|th)\b/i.test(v)) return true;
  // Single letter (e.g. cup size "C")
  if (/^[a-zA-Z]$/.test(v)) return true;
  return false;
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
    const normalizedKey = key.toLowerCase().trim();
    // Skip non-visual metadata keys entirely
    if (NON_VISUAL_APPEARANCE_KEYS.has(normalizedKey)) continue;
    if ([...NON_VISUAL_APPEARANCE_KEYS].some((k) => normalizedKey.includes(k))) continue;

    for (const tag of extractSeedTagsFromValue(value)) {
      if (looksLikeMeasurementOrDate(tag)) continue;
      if (normalizedKey === "hair") tags.add(tag.includes("hair") ? tag : `${tag} hair`);
      else if (normalizedKey === "eyes") tags.add(tag.includes("eyes") ? tag : `${tag} eyes`);
      else tags.add(tag);
    }
  }

  for (const section of parseAppearanceSections(draft.card.appearance)) {
    if (section.key.includes("hair")) {
      for (const tag of extractSeedTagsFromValue(section.value, "hair")) {
        if (!looksLikeMeasurementOrDate(tag)) tags.add(tag);
      }
    } else if (section.key.includes("eye")) {
      for (const tag of extractSeedTagsFromValue(section.value, "eyes")) {
        if (!looksLikeMeasurementOrDate(tag)) tags.add(tag);
      }
    } else if (
      section.key.includes("build") ||
      section.key.includes("body") ||
      section.key.includes("skin")
    ) {
      for (const tag of extractSeedTagsFromValue(section.value)) {
        if (!looksLikeMeasurementOrDate(tag)) tags.add(tag);
      }
    }
    // height and age sections removed — numeric values are not visual tags
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
        "You generate image-model tag prompts for character portrait generation.",
        "",
        "OUTPUT FORMAT — your entire response must be exactly two lines, in this order:",
        "positive: <comma-separated positive tags>",
        "negative: <comma-separated negative tags>",
        "",
        "Both lines are required. No prose. No explanations. No markdown. No headings. No extra lines.",
        "",
        "Example of a valid complete response:",
        "positive: masterpiece, best quality, newest, 1girl, solo, looking_at_viewer, portrait, long_hair, blue_eyes, white_dress, upper_body",
        "negative: worst quality, low quality, bad quality, jpeg artifacts, blurry, bad anatomy, bad hands, deformed, watermark",
        "",
        "NEGATIVE TAGS RULES (produce the negative line immediately after the positive line):",
        "Always include core quality negatives: worst quality, low quality, bad quality, jpeg artifacts, blurry.",
        "Include anatomy negatives: bad anatomy, bad hands, extra fingers, missing fingers, deformed, malformed.",
        "Add style-appropriate negatives: watermark, signature, text, border, censored.",
        "If the character style is identifiable (anime, realistic, etc.), add style-drift negatives.",
        "Target 8–16 negative tags.",
        "",
        "POSITIVE TAGS RULES:",
        "Convert EVERY piece of visual evidence into one or more Booru tags. Nothing visible should be omitted.",
        "Hair color and style, eye color, skin tone, body type, clothing, accessories, expression, pose — all must appear as tags.",
        "Use Booru-style tags: lowercase, underscores for multi-word tags (e.g. blue_eyes, long_hair, dark_skin, white_dress, cat_ears, upper_body).",
        "Quality baseline tags (masterpiece, best quality, newest) may use spaces.",
        "If a visual attribute has no exact Booru tag, pick the closest standard tag. Do not omit it.",
        "",
        "NEVER output any of the following — they are not visual tags an image model can render:",
        "- Body measurements or sizes (e.g. 35\", 31\", 27\", B cup, 165cm, 5'7\"). Convert to visual impressions instead (e.g. tall_female, large_breasts, slender).",
        "- Dates, birthdays, or any calendar reference (e.g. October 12th, Jan 5).",
        "- Ages expressed as a number (e.g. 8, 16, 24). Use visual age descriptors if needed (e.g. young_woman, mature_woman).",
        "- Single letters used as codes (e.g. C, B, A as size grades).",
        "- Species or race names verbatim. Convert to visible traits: 'Caracal Demi-human' → cat_ears, caracal_ears, animal_ears, kemonomimi_mode.",
        "- Abstract roleplay phrases, personality descriptions, or literary language.",
        "- Occupation titles, nationality, or lore-only labels with no visual meaning.",
        "",
        "Rank evidence by priority:",
        "  1. direct appearance facts — convert all of them, none may be skipped",
        "  2. role and title context",
        "  3. scene context",
        "  4. personality — only when it visibly affects expression, posture, or mood",
        "Do not invent unsupported wardrobe, props, creatures, or scenery.",
        "Include quality baseline: masterpiece, best quality, newest.",
        "Deduplicate. There is no upper tag limit — include every relevant visual attribute.",
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
    const normalizedTag = normalizeTag(part);
    const dedupeKey = normalizedTag.toLowerCase();
    if (!normalizedTag || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tags.push(normalizedTag);
  }

  return tags.join(", ");
}

/** Normalize a single tag string: clean up spacing and fix common space-separated Booru tags. */
function normalizeTag(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^looking at viewer$/i, "looking_at_viewer")
    .replace(/^from side$/i, "from_side")
    .replace(/^upper body$/i, "upper_body")
    .replace(/^full body$/i, "full_body")
    .trim();
}

/**
 * Parse a two-section LLM response of the form:
 *   positive: tag1, tag2, ...
 *   negative: tag1, tag2, ...
 *
 * Returns `null` if neither section is found (caller falls back to legacy single-block parsing).
 */
function parseSectionedTagResponse(
  content: string,
): { positive: string; negative: string } | null {
  const lines = content
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let positiveLine: string | null = null;
  let negativeLine: string | null = null;

  for (const line of lines) {
    const posMatch = line.match(/^pos(?:itive)?(?:\s+tags?)?\s*:\s*(.+)$/i);
    if (posMatch) { positiveLine = posMatch[1]; continue; }
    const negMatch = line.match(/^neg(?:ative)?(?:\s+tags?)?\s*:\s*(.+)$/i);
    if (negMatch) { negativeLine = negMatch[1]; continue; }
  }

  if (!positiveLine && !negativeLine) return null;

  const normalizeSection = (raw: string | null): string => {
    if (!raw) return "";
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const part of raw.split(",").map((p) => compactText(p)).filter(Boolean)) {
      const tag = normalizeTag(part);
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    return tags.join(", ");
  };

  return {
    positive: normalizeSection(positiveLine),
    negative: normalizeSection(negativeLine),
  };
}

export async function suggestVisualTags(
  input: SuggestVisualTagsInput,
): Promise<{ suggestedTags: string; suggestedNegativeTags: string }> {
  const deterministicSeed = buildDeterministicTagSeed(input.draft);

  const paramOverrides: Record<string, unknown> = {};
  if (input.params?.temperature != null) paramOverrides.temperature = input.params.temperature;
  if (input.params?.topP != null) paramOverrides.top_p = input.params.topP;
  if (input.params?.maxTokens != null) paramOverrides.max_tokens = input.params.maxTokens;
  if (input.params?.topK != null) paramOverrides.top_k = input.params.topK;

  const response = await quietGenerate(input.userId, {
    connection_id: input.connectionId ?? undefined,
    messages: buildTagSuggestionMessages(input.draft),
    parameters: {
      temperature: 0.35,
      max_tokens: 2048,
      ...paramOverrides,
    },
    signal: input.signal ?? undefined,
  });

  const parsed = parseSectionedTagResponse(response.content);

  // If the model returned the sectioned format, use it directly
  if (parsed) {
    const suggestedTags = parsed.positive;
    const suggestedNegativeTags = parsed.negative;

    const nonBaselineTags = suggestedTags
      .split(",")
      .map((t) => compactText(t))
      .filter((t) => !["masterpiece", "best quality", "newest", "very aesthetic"].includes(t.toLowerCase()));

    if (!suggestedTags || nonBaselineTags.length < 3) {
      return { suggestedTags: deterministicSeed.join(", "), suggestedNegativeTags };
    }

    return { suggestedTags, suggestedNegativeTags };
  }

  // Fallback: treat entire response as positive tags (legacy model behaviour)
  const suggestedTags = normalizeSuggestedTagBlock(response.content);
  const suggestedList = suggestedTags
    .split(",")
    .map((tag) => compactText(tag))
    .filter(Boolean);

  const nonBaselineTags = suggestedList.filter(
    (tag) => !["masterpiece", "best quality", "newest", "very aesthetic"].includes(tag.toLowerCase()),
  );

  if (!suggestedTags || nonBaselineTags.length < 3) {
    return { suggestedTags: deterministicSeed.join(", "), suggestedNegativeTags: "" };
  }

  return { suggestedTags, suggestedNegativeTags: "" };
}
