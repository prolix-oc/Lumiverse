/**
 * Memory Cortex — Emotional context detection for associative recall.
 *
 * Detects the emotional tone of the current conversation context and uses it
 * to boost retrieval of memories with matching emotional signatures.
 * This enables the "Proustian rush" — recalling memories by emotional
 * resonance rather than just semantic similarity.
 *
 * v2: Enhanced emotional analysis:
 *   - Fixed operator precedence bug in resonance calculation
 *   - Emotional polarity detection (positive, negative, mixed)
 *   - Context-aware sensory triggers (rain isn't always melancholy)
 *   - Intensity-weighted resonance scoring
 *   - Emotional transition detection across message boundaries
 */

import type { EmotionalTag } from "./types";
import { detectEmotionalTags } from "./salience-heuristic";

// ─── Emotional Polarity ────────────────────────────────────────

const POSITIVE_EMOTIONS: Set<EmotionalTag> = new Set(["joy", "intimacy", "resolve", "humor", "awe"]);
const NEGATIVE_EMOTIONS: Set<EmotionalTag> = new Set(["grief", "dread", "betrayal", "fury"]);
// tension, revelation, melancholy are ambivalent

export interface EmotionalPolarity {
  positive: number;
  negative: number;
  ambivalent: number;
  dominant: "positive" | "negative" | "mixed" | "neutral";
}

/**
 * Analyze the emotional polarity of a set of tags.
 */
export function analyzePolarity(tags: EmotionalTag[]): EmotionalPolarity {
  let pos = 0, neg = 0, amb = 0;
  for (const tag of tags) {
    if (POSITIVE_EMOTIONS.has(tag)) pos++;
    else if (NEGATIVE_EMOTIONS.has(tag)) neg++;
    else amb++;
  }
  const total = tags.length;
  if (total === 0) return { positive: 0, negative: 0, ambivalent: 0, dominant: "neutral" };

  const dominant: EmotionalPolarity["dominant"] =
    pos > 0 && neg > 0 ? "mixed" :
    pos > neg ? "positive" :
    neg > pos ? "negative" :
    "neutral";

  return { positive: pos, negative: neg, ambivalent: amb, dominant };
}

// ─── Core Detection ────────────────────────────────────────────

/**
 * Detect the emotional context of recent messages for use in retrieval boosting.
 */
export function detectEmotionalContext(recentContent: string): EmotionalTag[] {
  return detectEmotionalTags(recentContent);
}

// ─── Resonance Calculation ─────────────────────────────────────

/**
 * Calculate the emotional resonance between a query's emotional context
 * and a memory chunk's emotional tags.
 *
 * Each matching tag contributes a boost with diminishing returns.
 * Also considers polarity alignment (same emotional valence = stronger match).
 *
 * @returns Resonance score from 0.0 to 1.0
 */
export function calculateEmotionalResonance(
  queryEmotions: EmotionalTag[],
  memoryEmotions: EmotionalTag[],
): number {
  if (queryEmotions.length === 0 || memoryEmotions.length === 0) return 0;

  const memorySet = new Set(memoryEmotions);
  let matchCount = 0;

  for (const tag of queryEmotions) {
    if (memorySet.has(tag)) matchCount++;
  }

  if (matchCount === 0) {
    // No exact tag matches — check for polarity alignment as a weaker signal
    const queryPolarity = analyzePolarity(queryEmotions);
    const memoryPolarity = analyzePolarity(memoryEmotions);
    if (queryPolarity.dominant !== "neutral" && queryPolarity.dominant === memoryPolarity.dominant) {
      return 0.15; // Weak resonance from same emotional valence
    }
    return 0;
  }

  // Diminishing returns: 1st match = 0.4, 2nd = +0.25, 3rd+ = +0.12 each
  let score = 0.4;
  if (matchCount >= 2) score += 0.25;
  if (matchCount >= 3) score += (matchCount - 2) * 0.12;

  // Bonus for matching rare/intense emotions (betrayal, death-adjacent)
  const highIntensityTags: Set<EmotionalTag> = new Set(["betrayal", "grief", "fury", "dread"]);
  for (const tag of queryEmotions) {
    if (memorySet.has(tag) && highIntensityTags.has(tag)) {
      score += 0.08; // Matching intense emotions = stronger resonance
      break; // Only one bonus
    }
  }

  return Math.min(1.0, score);
}

// ─── Sensory Triggers ──────────────────────────────────────────

/**
 * Detect sensory/atmospheric details that might trigger associative recall.
 * Context-aware: considers surrounding words to disambiguate
 * (e.g., "rain" + "danced" = joy, not melancholy).
 */
export function detectSensoryTriggers(content: string): EmotionalTag[] {
  const triggers: EmotionalTag[] = [];
  const contentLower = content.toLowerCase();

  const sensoryPatterns: Array<{
    tags: EmotionalTag[];
    pattern: RegExp;
    override?: { pattern: RegExp; tags: EmotionalTag[] };
  }> = [
    {
      tags: ["melancholy"],
      pattern: /\b(rain|storm|grey|cold|wind|autumn|fading|twilight|dusk|mist)\b/i,
      // Override: rain + positive context = joy
      override: { pattern: /\b(danc(?:ed|ing)|laugh(?:ed|ing)|play(?:ed|ing)|splash(?:ed|ing)|warm)\b/i, tags: ["joy"] },
    },
    {
      tags: ["intimacy"],
      pattern: /\b(warm|fire(?:light|place)?|candle|soft\s+(?:light|glow)|quiet\s+(?:room|night|moment))\b/i,
    },
    {
      tags: ["dread"],
      pattern: /\b(dark(?:ness)?|shadow|silence|echo|empty|hollow|beneath|deep|underground|cave|tomb)\b/i,
      // Override: dark + cozy context = intimacy
      override: { pattern: /\b(warm|cozy|comfortable|safe|together|close|held)\b/i, tags: ["intimacy"] },
    },
    {
      tags: ["awe"],
      pattern: /\b(stars?|sky|vast|horizon|mountain|ocean|light|dawn|sunrise|ancient|cathedral|temple|monument)\b/i,
    },
    {
      tags: ["tension"],
      pattern: /\b(smoke|iron|steel|sharp|edge|narrow|tight|trap|corner|alley|footsteps)\b/i,
    },
    {
      tags: ["joy"],
      pattern: /\b(music|song|dance|feast|bright|color|bloom|spring|garden|laughter|festival|celebration)\b/i,
    },
    // New sensory categories
    {
      tags: ["melancholy"],
      pattern: /\b(photograph|letter|keepsake|memento|old\s+(?:song|book|place)|faded|worn|dusty|abandoned)\b/i,
    },
    {
      tags: ["dread"],
      pattern: /\b(blood|rust|decay|rot|stench|creaking|dripping|scratching|whisper(?:s|ing)?\s+(?:in\s+the|from))\b/i,
    },
  ];

  for (const { tags, pattern, override } of sensoryPatterns) {
    if (pattern.test(contentLower)) {
      // Check for context override
      if (override && override.pattern.test(contentLower)) {
        for (const tag of override.tags) {
          if (!triggers.includes(tag)) triggers.push(tag);
        }
      } else {
        for (const tag of tags) {
          if (!triggers.includes(tag)) triggers.push(tag);
        }
      }
    }
  }

  return triggers;
}

// ─── Emotional Transition Detection ────────────────────────────

/**
 * Detect emotional transitions in sequential content blocks.
 * A shift from positive → negative (or vice versa) signals a pivotal moment.
 *
 * @param contentBlocks - Sequential message contents
 * @returns Tags representing the emotional arc of the transition
 */
export function detectEmotionalTransition(contentBlocks: string[]): EmotionalTag[] {
  if (contentBlocks.length < 2) return [];

  const firstHalf = contentBlocks.slice(0, Math.ceil(contentBlocks.length / 2)).join(" ");
  const secondHalf = contentBlocks.slice(Math.ceil(contentBlocks.length / 2)).join(" ");

  const firstTags = detectEmotionalTags(firstHalf);
  const secondTags = detectEmotionalTags(secondHalf);

  const firstPolarity = analyzePolarity(firstTags);
  const secondPolarity = analyzePolarity(secondTags);

  // Polarity shift = emotional transition (worth remembering)
  if (
    (firstPolarity.dominant === "positive" && secondPolarity.dominant === "negative") ||
    (firstPolarity.dominant === "negative" && secondPolarity.dominant === "positive")
  ) {
    // Return the LATER emotions — the destination of the arc
    return secondTags;
  }

  return [];
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Build the full emotional context for a retrieval query.
 * Combines direct emotional detection with sensory triggers
 * and (optionally) transition signals.
 */
export function buildEmotionalContext(
  recentContent: string,
  recentBlocks?: string[],
): EmotionalTag[] {
  const direct = detectEmotionalContext(recentContent);
  const sensory = detectSensoryTriggers(recentContent);
  const transition = recentBlocks ? detectEmotionalTransition(recentBlocks) : [];

  // Merge: direct first (highest confidence), then transition, then sensory
  const combined = [...direct];
  for (const tag of transition) {
    if (!combined.includes(tag)) combined.push(tag);
  }
  for (const tag of sensory) {
    if (!combined.includes(tag)) combined.push(tag);
  }

  // Cap at 6 tags to keep the signal focused
  return combined.slice(0, 6);
}
