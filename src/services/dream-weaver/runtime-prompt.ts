import type { Character } from "../../types/character";

type DreamWeaverVoiceRules = {
  baseline?: unknown;
  rhythm?: unknown;
  diction?: unknown;
  quirks?: unknown;
  hard_nos?: unknown;
};

type DreamWeaverPromptMetadata = {
  appearance?: unknown;
  appearance_data?: unknown;
  voice_guidance?: {
    compiled?: unknown;
    rules?: DreamWeaverVoiceRules;
  };
};

export type DreamWeaverRuntimeBlock = {
  name: "Dream Weaver Appearance (auto)" | "Dream Weaver Voice (auto)";
  content: string;
};

export function getDreamWeaverPromptMetadata(
  source: Pick<Character, "extensions"> | DreamWeaverPromptMetadata | null | undefined,
): DreamWeaverPromptMetadata | null {
  if (!source || typeof source !== "object") return null;
  if ("extensions" in source) {
    const dw = source.extensions?.dream_weaver;
    return dw && typeof dw === "object" ? dw as DreamWeaverPromptMetadata : null;
  }
  return source;
}

export function buildDreamWeaverAppearanceBlock(
  source: Pick<Character, "extensions"> | DreamWeaverPromptMetadata | null | undefined,
): string {
  const meta = getDreamWeaverPromptMetadata(source);
  if (!meta) return "";

  const appearance = coerceString(meta.appearance);
  if (appearance) return `## Character Appearance\n${appearance}`;

  const lines = formatAppearanceData(meta.appearance_data);
  return lines.length > 0 ? `## Character Appearance\n${lines.join("\n")}` : "";
}

export function buildDreamWeaverVoiceBlock(
  source: Pick<Character, "extensions"> | DreamWeaverPromptMetadata | null | undefined,
): string {
  const meta = getDreamWeaverPromptMetadata(source);
  if (!meta) return "";

  const structured = buildStructuredVoiceGuidance(meta.voice_guidance?.rules);
  if (structured) return `## Voice & Speech Patterns\n${structured}`;

  const compiled = coerceString(meta.voice_guidance?.compiled);
  return compiled ? `## Voice & Speech Patterns\n${compiled}` : "";
}

export function stripLegacyDreamWeaverVoiceSection(
  systemPrompt: string,
  source: Pick<Character, "extensions"> | DreamWeaverPromptMetadata | null | undefined,
): string {
  const meta = getDreamWeaverPromptMetadata(source);
  if (!meta) return systemPrompt || "";

  const compiled = coerceString(meta.voice_guidance?.compiled);
  if (!compiled) return systemPrompt || "";

  const voiceSection = `## Voice & Speech Patterns\n${compiled}`;
  const trimmedEnd = (systemPrompt || "").replace(/\s+$/, "");
  if (trimmedEnd === voiceSection) return "";
  if (trimmedEnd.endsWith(`\n\n${voiceSection}`)) {
    return trimmedEnd.slice(0, -(`\n\n${voiceSection}`).length).trimEnd();
  }
  return systemPrompt || "";
}

export function getDreamWeaverRuntimeBlocks(
  character: Pick<Character, "extensions">,
): DreamWeaverRuntimeBlock[] {
  const blocks: DreamWeaverRuntimeBlock[] = [];
  const appearance = buildDreamWeaverAppearanceBlock(character);
  if (appearance) blocks.push({ name: "Dream Weaver Appearance (auto)", content: appearance });

  const voice = buildDreamWeaverVoiceBlock(character);
  if (voice) blocks.push({ name: "Dream Weaver Voice (auto)", content: voice });

  return blocks;
}

function buildStructuredVoiceGuidance(rules: DreamWeaverVoiceRules | undefined): string {
  if (!rules || typeof rules !== "object") return "";
  const sections: string[] = [];
  pushVoiceSection(sections, "Baseline", rules.baseline);
  pushVoiceSection(sections, "Rhythm", rules.rhythm);
  pushVoiceSection(sections, "Diction", rules.diction);
  pushVoiceSection(sections, "Quirks", rules.quirks);
  pushVoiceSection(sections, "Hard No's", rules.hard_nos);
  return sections.join("\n\n");
}

function pushVoiceSection(sections: string[], title: string, value: unknown): void {
  const lines = toStringArray(value);
  if (lines.length === 0) return;
  sections.push(`${title}:\n${lines.map((line) => `- ${line}`).join("\n")}`);
}

function formatAppearanceData(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    const normalized = coerceString(raw);
    if (!normalized) continue;
    lines.push(`${humanizeKey(key)}: ${normalized}`);
  }
  return lines;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(coerceString).filter(Boolean) : [];
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function coerceString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}
