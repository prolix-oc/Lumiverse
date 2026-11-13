// ─── Bot Name Filler ──────────────────────────────────────────
// Words used by card labels and scenario segments. Only discard a whole
// delimited metadata segment: these words can also be part of a real name.

const BOT_NAME_FILLER = new Set([
  // Meta / platform tags
  "live", "new", "old", "reloaded", "remake", "rework", "updated", "original",
  "alternate", "version", "edition", "nsfw", "sfw", "oc", "wip", "beta", "au", "canon",
  // Narrative structure
  "episode", "chapter", "part", "scenario", "adventure", "story", "encounter",
  "meeting", "date", "quest", "tale", "journey", "arc", "prologue", "epilogue",
  // Genre tags
  "modern", "fantasy", "romance", "action", "horror", "mystery", "drama",
  "comedy", "thriller", "historical", "futuristic", "dystopian", "supernatural",
  // Common descriptive filler
  "chance", "interrogation", "confrontation", "conversation", "introduction",
  // Interjections / filler words
  "ah", "oh", "hey", "hi", "yo", "welcome",
  // Articles / prepositions used in metadata-only segments
  "the", "a", "an", "of", "in", "at", "to", "for", "with", "by", "and", "or",
]);

/**
 * Remove explicit card decorations while preserving the complete name.
 *
 * Handles common bot-card naming patterns:
 *   - Tag prefixes: "LIVE:", "NSFW:", "OC:", "[WIP]"
 *   - Structural separators: spaced hyphen, |, _, —, –, :, /
 *   - Decorative Unicode: emoji, CJK brackets, symbols
 *   - Delimited scenario suffixes: "| A Chance Interrogation", "— Modern AU"
 *
 * Prefer the first non-metadata segment. Do not infer a person's identity by
 * selecting title-cased words: "Still in Love", particles, lowercase names
 * and names containing genre words must survive intact.
 */
export function normalizeCharacterName(rawName: string): string {
  // 1. Strip emoji and decorative Unicode
  let cleaned = rawName;
  try {
    cleaned = cleaned.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
  } catch { /* regex unicode support varies */ }
  cleaned = cleaned.replace(/[「」『』【】〖〗★☆✨~♡♥●○◆◇■□▪▫▲△▶◀♪♫§†‡※•·]/g, "");

  // 2. Strip bracketed tags: [OC], (NSFW), {WIP}, etc.
  cleaned = cleaned.replace(/[\[({]\s*(?:OC|NSFW|SFW|WIP|BETA|AU|CANON|NEW|UPDATED?|REMAKE|V\d+(?:\.\d+)?)\s*[\])}]/gi, "");

  // 3. Split on structural separators
  const segments = cleaned.split(/\s+-\s+|[|_—–:\/\\]/).map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

  // 4. Reject standalone labels, never individual words inside a name. When
  // every segment looks like metadata, preserve the first as the identity.
  return segments.find((segment) => !segment.split(/[\s,]+/).every((word) => {
    const key = word.toLowerCase().replace(/[.,;:!?"'()\[\]{}]+/g, "");
    return BOT_NAME_FILLER.has(key) || /^v?\d+(?:\.\d+)*$/i.test(key);
  })) ?? segments[0] ?? rawName.trim();
}

/** A coordinated card label can route several characters. It is never an alias
 * for any one of them. These are identity hints, not evidence of presence. */
export function getCortexCharacterNames(rawName: string): string[] {
  const normalized = normalizeCharacterName(rawName);
  const parts = normalized.split(/\s+(?:and|&|\+)\s+|,\s*(?:and\s+)?/iu).map((part) => part.trim()).filter(Boolean);
  const isName = (part: string) => part.length <= 80
    && /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(part)
    && part.split(/\s+/).length <= 8
    && !part.split(/\s+/).every((word) => BOT_NAME_FILLER.has(word.toLowerCase()));
  return parts.length > 1 && parts.every(isName) ? [...new Set(parts)] : [normalized];
}
