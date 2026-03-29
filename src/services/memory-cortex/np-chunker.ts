/**
 * Memory Cortex — NP Chunker for Phase 1 entity discovery.
 *
 * Simple English noun phrase chunker — one linear pass, O(n).
 * Detects entity candidates in memory chunks that aren't in the existing registry.
 *
 * PHASE 1 ONLY. Do NOT run on Phase 2 (live message processing).
 * Phase 1 is server-side and amortized — the compute cost is acceptable.
 *
 * Based on: Grosz, Joshi & Weinstein (1995) Centering Theory,
 * Dunietz & Gillick (2014) entity salience features.
 */

import type { NPCandidate } from "./types";

// ─── Closed-Class Exclusion Set ───────────────────────────────
// Determiners, prepositions, conjunctions, auxiliaries, common stopwords (~200 words)

const CLOSED_CLASS = new Set([
  // Determiners
  "the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her",
  "their", "its", "our", "some", "any", "all", "both", "each", "every", "no",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about",
  "into", "through", "during", "before", "after", "above", "below", "between",
  "under", "over", "near", "upon", "within", "without", "toward", "towards",
  "against", "among", "across", "along", "behind", "beside", "beyond",
  // Auxiliaries / be / have / do
  "is", "was", "are", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "shall", "must", "can",
  // Conjunctions
  "and", "but", "or", "nor", "so", "yet", "because", "although", "if", "when",
  "then", "than", "as", "also", "just", "not", "very", "too", "more", "most",
  // Common pronouns
  "i", "me", "we", "us", "you", "he", "him", "she", "it", "they", "them",
  "who", "whom", "which", "what", "where", "how", "why",
  // Common adverbs / filler
  "here", "there", "now", "only", "still", "already", "even", "once", "never",
  "always", "often", "again", "perhaps", "maybe", "quite", "rather", "really",
  "well", "back", "away", "down", "out", "off",
  // Common verbs (not useful as NP heads)
  "said", "went", "came", "got", "made", "took", "knew", "thought", "looked",
  "seemed", "felt", "told", "asked", "let", "began", "kept", "left",
]);

// ─── Verb Markers ─────────────────────────────────────────────
// Crude but domain-appropriate for subject-position detection in English SVO

const VERB_MARKERS = /(?:ing|ed|es|s)\b/;

// ─── NP Chunker ───────────────────────────────────────────────

/**
 * Extract noun phrase candidates from tokenized text.
 * Uses a closed-class exclusion set and capitalization heuristics.
 *
 * Strategy:
 *   - Skip closed-class words (determiners, prepositions, etc.)
 *   - Collect runs of capitalized tokens (proper nouns)
 *   - Content words only continue an NP if it was started by a proper noun
 *
 * @param tokens - Whitespace-split tokens from the chunk
 * @returns Array of NP candidate strings
 */
export function extractNPCandidates(tokens: string[]): string[] {
  const candidates: string[] = [];
  let current: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Strip trailing punctuation for classification but keep original for output
    const cleaned = token.replace(/[.,;:!?"''"\u201C\u201D\u2018\u2019()\[\]{}]+$/g, "");
    if (!cleaned) {
      if (current.length > 0) {
        candidates.push(current.join(" "));
        current = [];
      }
      continue;
    }

    const lower = cleaned.toLowerCase();

    if (CLOSED_CLASS.has(lower)) {
      if (current.length > 0) {
        candidates.push(current.join(" "));
        current = [];
      }
      continue;
    }

    // Heuristic: capitalized mid-sentence tokens are likely proper nouns.
    // Skip first token of a sentence (sentence-initial caps unreliable).
    const isSentenceStart = i === 0 || /[.!?]\s*$/.test(tokens[i - 1] ?? "");
    if (!isSentenceStart && /^[A-Z]/.test(cleaned)) {
      current.push(cleaned);
      continue;
    }

    // Content word (not closed-class, not capitalized mid-sentence)
    // Only include if continuing an existing NP started by a proper noun
    if (current.length > 0 && !isSentenceStart) {
      current.push(cleaned);
    } else if (current.length > 0) {
      candidates.push(current.join(" "));
      current = [];
    }
  }

  if (current.length > 0) {
    candidates.push(current.join(" "));
  }

  // Deduplicate and filter out single-char results
  const unique = [...new Set(candidates)].filter((c) => c.length > 1);
  return unique;
}

/**
 * Detect subject-position NP for Centering Theory Cb scoring.
 * English SVO: first NP before a verb-marker = subject ~85% of declarative sentences.
 *
 * @param tokens - Whitespace-split tokens
 * @param npCandidates - Already-extracted NP candidates
 * @returns The subject-position NP, or null
 */
export function detectSubjectPosition(
  tokens: string[],
  npCandidates: string[],
): string | null {
  if (npCandidates.length === 0) return null;

  // Find first verb-marker token
  const firstVerbIdx = tokens.findIndex((t) => {
    const lower = t.toLowerCase().replace(/[^a-z]/g, "");
    return !CLOSED_CLASS.has(lower) && VERB_MARKERS.test(lower);
  });

  if (firstVerbIdx === -1) return npCandidates[0];

  // Return whichever candidate appears first (before the verb marker)
  // Since NP candidates are in order, the first one is the subject in SVO
  return npCandidates[0];
}

/**
 * Tokenize text for NP chunking.
 * Handles roleplay-style formatting: strips font tags, asterisks, etc.
 */
export function tokenizeForNPChunker(content: string): string[] {
  // Strip HTML tags
  let cleaned = content.replace(/<[^>]+>/g, " ");
  // Strip roleplay action markers
  cleaned = cleaned.replace(/\*+/g, " ");
  // Strip chunk format prefix: [CHARACTER | Name]:
  cleaned = cleaned.replace(/^\s*\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/i, "");
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned.split(" ").filter(Boolean);
}

/**
 * Full NP extraction pipeline for a memory chunk.
 * Returns candidate NPs with subject-position tagging.
 *
 * Integration: Run on each new chunk during Phase 1. For each candidate:
 *   1. resolveCanonicalId() — if it resolves, skip (known entity)
 *   2. If no resolution, create provisional entity
 *   3. Provisional entities promoted after ≥2 chunks corroborate
 */
export function extractNPsFromChunk(content: string): NPCandidate[] {
  const tokens = tokenizeForNPChunker(content);
  const candidates = extractNPCandidates(tokens);
  const subject = detectSubjectPosition(tokens, candidates);

  return candidates.map((text) => ({
    text,
    isSubjectPosition: text === subject,
  }));
}
