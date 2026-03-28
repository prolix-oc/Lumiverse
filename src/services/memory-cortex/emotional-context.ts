/**
 * Memory Cortex — Emotional context detection for associative recall.
 *
 * Detects the emotional tone of the current conversation context and uses it
 * to boost retrieval of memories with matching emotional signatures.
 * This enables the "Proustian rush" — recalling memories by emotional
 * resonance rather than just semantic similarity.
 */

import type { EmotionalTag } from "./types";
import { detectEmotionalTags } from "./salience-heuristic";

/**
 * Detect the emotional context of recent messages for use in retrieval boosting.
 * Takes the last N messages' content and returns the dominant emotional tones.
 *
 * @param recentContent - Concatenated content of recent messages
 * @returns Array of emotional tags detected in the content
 */
export function detectEmotionalContext(recentContent: string): EmotionalTag[] {
  return detectEmotionalTags(recentContent);
}

/**
 * Calculate the emotional resonance score between a query's emotional context
 * and a memory chunk's emotional tags.
 *
 * Each matching tag contributes a boost, with diminishing returns for
 * multiple matches. This prevents any single dimension from dominating.
 *
 * @param queryEmotions - Emotional tags from the current context
 * @param memoryEmotions - Emotional tags stored on the memory chunk
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

  if (matchCount === 0) return 0;

  // Diminishing returns: first match = 0.4, second = 0.25, third+ = 0.15 each
  const score =
    matchCount >= 1 ? 0.4 : 0 +
    matchCount >= 2 ? 0.25 : 0 +
    matchCount >= 3 ? (matchCount - 2) * 0.15 : 0;

  return Math.min(1.0, score);
}

/**
 * Detect if the current context contains sensory or atmospheric details
 * that might trigger associative recall of past scenes with similar ambiance.
 *
 * Returns additional emotional tags for sensory associations.
 */
export function detectSensoryTriggers(content: string): EmotionalTag[] {
  const triggers: EmotionalTag[] = [];

  // Sensory patterns that evoke past scenes
  const sensoryPatterns: Array<{ tags: EmotionalTag[]; pattern: RegExp }> = [
    { tags: ["melancholy"], pattern: /\b(rain|storm|grey|cold|wind|autumn|fading|twilight|dusk|mist)\b/i },
    { tags: ["intimacy"], pattern: /\b(warm|fire(?:light|place)?|candle|soft|quiet|gentle|close)\b/i },
    { tags: ["dread"], pattern: /\b(dark(?:ness)?|shadow|silence|echo|empty|hollow|beneath|deep)\b/i },
    { tags: ["awe"], pattern: /\b(stars?|sky|vast|horizon|mountain|ocean|light|dawn|sunrise|ancient)\b/i },
    { tags: ["tension"], pattern: /\b(smoke|iron|steel|sharp|edge|narrow|tight|trap|corner)\b/i },
    { tags: ["joy"], pattern: /\b(music|song|dance|feast|bright|color|bloom|spring|garden|laughter)\b/i },
  ];

  for (const { tags, pattern } of sensoryPatterns) {
    if (pattern.test(content)) {
      for (const tag of tags) {
        if (!triggers.includes(tag)) triggers.push(tag);
      }
    }
  }

  return triggers;
}

/**
 * Build the full emotional context for a retrieval query.
 * Combines direct emotional detection with sensory triggers.
 */
export function buildEmotionalContext(recentContent: string): EmotionalTag[] {
  const direct = detectEmotionalContext(recentContent);
  const sensory = detectSensoryTriggers(recentContent);

  // Merge without duplicates, direct tags take priority
  const combined = [...direct];
  for (const tag of sensory) {
    if (!combined.includes(tag)) combined.push(tag);
  }

  // Cap at 6 tags to keep the signal focused
  return combined.slice(0, 6);
}
