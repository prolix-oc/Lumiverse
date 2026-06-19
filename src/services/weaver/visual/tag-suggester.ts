import type { LlmMessage } from "../../../llm/types";
import type { WeaverSession } from "../../../types/weaver";
import { quietGenerate } from "../../generate.service";
import { resolveWeaverConnection } from "../llm";

interface CharacterEvidenceSource {
  name: string;
  description: string;
  personality: string;
  scenario: string;
}

export interface WeaverTagEvidence {
  appearance: string;
  roleFacts: string;
  sceneFacts: string;
  visualPersonality: string;
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

function extractAppearance(description: string): string {
  const re = /\[([A-Z][A-Z ]*)\]/g;
  const marks: { tag: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    marks.push({ tag: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  const formIdx = marks.findIndex((mk) => mk.tag === "FORM");
  let body = description;
  if (formIdx !== -1) {
    const start = marks[formIdx].end;
    const end = formIdx + 1 < marks.length ? marks[formIdx + 1].start : undefined;
    body = description.slice(start, end);
  }
  return compactText(body.replace(/^\s*\([^)]*\)\s*/, ""));
}

export function buildTagEvidenceFromCharacter(character: CharacterEvidenceSource): WeaverTagEvidence {
  return {
    appearance: extractAppearance(character.description ?? ""),
    roleFacts: [compactText(character.name), compactText(character.description)].filter(Boolean).join("\n"),
    sceneFacts: compactText(character.scenario),
    visualPersonality: compactText(character.personality),
  };
}

function parseAppearanceSections(appearance: string): Array<{ key: string; value: string }> {
  return stripMarkdown(appearance)
    .split(/\n+/)
    .map((line) => compactText(line))
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (!match) return null;
      return { key: compactText(match[1]).toLowerCase(), value: compactText(match[2]) };
    })
    .filter((entry): entry is { key: string; value: string } => Boolean(entry?.key && entry.value));
}

function looksLikeMeasurementOrDate(value: string): boolean {
  const v = value.trim();
  if (/^\d[\d.,'"\s]*(?:cm|mm|m|kg|lb|lbs|inch|inches|ft|'|")?$/i.test(v)) return true;
  if (/^\d+(?:[.,]\d+)?(?:\s*[,/]\s*\d+(?:[.,]\d+)?){1,5}\s*(?:"|cm)?$/.test(v)) return true;
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(v)) return true;
  if (/\b\d{1,2}(?:st|nd|rd|th)\b/i.test(v)) return true;
  if (/^[a-zA-Z]$/.test(v)) return true;
  return false;
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

/** Deterministic fallback seed: quality baseline + portrait basics + parsed appearance. */
export function buildDeterministicTagSeed(evidence: WeaverTagEvidence): string[] {
  const tags = new Set<string>(["masterpiece", "best quality", "newest", "1girl", "solo", "looking_at_viewer", "portrait"]);

  for (const section of parseAppearanceSections(evidence.appearance)) {
    if (section.key.includes("hair")) {
      for (const tag of extractSeedTagsFromValue(section.value, "hair")) if (!looksLikeMeasurementOrDate(tag)) tags.add(tag);
    } else if (section.key.includes("eye")) {
      for (const tag of extractSeedTagsFromValue(section.value, "eyes")) if (!looksLikeMeasurementOrDate(tag)) tags.add(tag);
    } else if (section.key.includes("build") || section.key.includes("body") || section.key.includes("skin")) {
      for (const tag of extractSeedTagsFromValue(section.value)) if (!looksLikeMeasurementOrDate(tag)) tags.add(tag);
    }
  }

  return [...tags].slice(0, 18);
}

function buildTagSuggestionMessages(evidence: WeaverTagEvidence): LlmMessage[] {
  const appearance = stripMarkdown(evidence.appearance) || "None";
  const roleFacts = evidence.roleFacts || "None";
  const sceneFacts = evidence.sceneFacts || "None";
  const visualPersonality = evidence.visualPersonality || "None";
  const deterministicSeed = buildDeterministicTagSeed(evidence).join(", ");

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
        "- Body measurements or sizes (e.g. 35\", B cup, 165cm, 5'7\"). Convert to visual impressions (e.g. tall_female, large_breasts, slender).",
        "- Dates, birthdays, or any calendar reference.",
        "- Ages expressed as a number. Use visual age descriptors if needed (e.g. young_woman, mature_woman).",
        "- Single letters used as codes.",
        "- Species or race names verbatim. Convert to visible traits: 'Caracal Demi-human' → cat_ears, animal_ears, kemonomimi_mode.",
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

function normalizeTag(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^looking at viewer$/i, "looking_at_viewer")
    .replace(/^from side$/i, "from_side")
    .replace(/^upper body$/i, "upper_body")
    .replace(/^full body$/i, "full_body")
    .trim();
}

function normalizeSection(raw: string | null): string {
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
}

/** Parse the two-line `positive:` / `negative:` response. Null if neither found. */
export function parseSectionedTagResponse(content: string): { positive: string; negative: string } | null {
  const lines = content.replace(/\r/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  let positiveLine: string | null = null;
  let negativeLine: string | null = null;
  for (const line of lines) {
    const posMatch = line.match(/^pos(?:itive)?(?:\s+tags?)?\s*:\s*(.+)$/i);
    if (posMatch) { positiveLine = posMatch[1]; continue; }
    const negMatch = line.match(/^neg(?:ative)?(?:\s+tags?)?\s*:\s*(.+)$/i);
    if (negMatch) { negativeLine = negMatch[1]; continue; }
  }
  if (!positiveLine && !negativeLine) return null;
  return { positive: normalizeSection(positiveLine), negative: normalizeSection(negativeLine) };
}

const BASELINE = ["masterpiece", "best quality", "newest", "very aesthetic"];

export interface SuggestWeaverTagsInput {
  userId: string;
  session: WeaverSession;
  evidence: WeaverTagEvidence;
  signal?: AbortSignal;
}

export interface SuggestedTags {
  suggestedTags: string;
  suggestedNegativeTags: string;
}

/** Run the BYO LLM over the evidence and return positive + negative tag lines. */
export async function suggestVisualTags(input: SuggestWeaverTagsInput): Promise<SuggestedTags> {
  const { conn, model } = resolveWeaverConnection(input.userId, input.session);
  const deterministicSeed = buildDeterministicTagSeed(input.evidence);

  const response = await quietGenerate(input.userId, {
    connection_id: conn.id,
    messages: buildTagSuggestionMessages(input.evidence),
    parameters: { model, temperature: 0.35, max_tokens: 2048 },
    signal: input.signal,
  });

  const parsed = parseSectionedTagResponse(response.content);
  if (parsed) {
    const nonBaseline = parsed.positive.split(",").map((t) => compactText(t)).filter((t) => !BASELINE.includes(t.toLowerCase()));
    if (!parsed.positive || nonBaseline.length < 3) {
      return { suggestedTags: deterministicSeed.join(", "), suggestedNegativeTags: parsed.negative };
    }
    return { suggestedTags: parsed.positive, suggestedNegativeTags: parsed.negative };
  }

  // Fallback: treat the whole response as positive tags.
  const positive = normalizeSection(response.content.replace(/\r/g, "\n").split("\n").join(", "));
  const nonBaseline = positive.split(",").map((t) => compactText(t)).filter((t) => t && !BASELINE.includes(t.toLowerCase()));
  if (!positive || nonBaseline.length < 3) {
    return { suggestedTags: deterministicSeed.join(", "), suggestedNegativeTags: "" };
  }
  return { suggestedTags: positive, suggestedNegativeTags: "" };
}
