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
  // Contractions (pronoun + auxiliary) — normalized to standard apostrophe
  "i'm", "i've", "i'll", "i'd", "he's", "she's", "it's", "we're", "they're",
  "you're", "we've", "they've", "you've", "he'd", "she'd", "we'd", "they'd",
  "you'd", "won't", "can't", "don't", "doesn't", "didn't", "couldn't",
  "wouldn't", "shouldn't", "isn't", "aren't", "wasn't", "weren't",
  "hasn't", "haven't", "hadn't", "let's", "that's", "there's", "here's",
  "what's", "who's", "how's", "where's", "when's",
]);

// ─── Single-Word Reject Set ──────────────────────────────────
// Capitalized single words that are clearly not proper nouns.
// Verb forms, expletives, and common adjectives that appear capitalized
// at dialogue boundaries or for stylistic emphasis in roleplay prose.

const SINGLE_WORD_REJECT = new Set([
  // Gerunds / present participles
  "having", "being", "going", "coming", "getting", "making", "taking",
  "seeing", "looking", "saying", "doing", "running", "walking", "talking",
  "trying", "asking", "telling", "leaving", "sitting", "standing",
  "feeling", "thinking", "waiting", "watching", "holding", "pulling",
  "pushing", "reaching", "climbing", "falling", "turning", "moving",
  "opening", "closing", "breaking", "cutting", "setting", "putting",
  // Past tense / past participles
  "turned", "walked", "looked", "started", "stopped", "opened", "closed",
  "moved", "pulled", "pushed", "dropped", "picked", "placed", "reached",
  "stepped", "climbed", "slurred", "mumbled", "whispered", "shouted",
  "screamed", "laughed", "smiled", "frowned", "nodded", "shrugged",
  "grabbed", "slammed", "stumbled", "shivered", "trembled", "collapsed",
  "continued", "replied", "answered", "noticed", "realized", "decided",
  "appeared", "remained", "finished", "returned", "glanced", "stared",
  // Base / present tense verbs
  "set", "sets", "put", "puts", "run", "runs", "see", "sees", "seen",
  "go", "goes", "gone", "leave", "leaves", "give", "gives", "given",
  "take", "takes", "taken", "come", "comes", "find", "finds", "found",
  "want", "wants", "need", "needs", "know", "knows", "think", "thinks",
  "turn", "turns", "start", "starts", "move", "moves", "try", "tries",
  "call", "calls", "hold", "holds", "stand", "stands", "hear", "hears",
  "bring", "brings", "sit", "sits", "keep", "keeps", "watch", "watches",
  // Expletives / interjections
  "fuck", "shit", "damn", "hell", "crap", "bloody", "bastard", "bitch",
  "god", "christ", "jesus", "ugh", "hmm", "huh", "wow", "oh", "ah",
  // Common adjectives that get capitalized in dialogue
  "dark", "cold", "warm", "large", "small", "long", "short", "high",
  "low", "deep", "wide", "bright", "quiet", "loud", "fast", "slow",
  "enough", "several", "certain", "different", "important", "strange",
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
 *   - Only capitalized words form proper noun NPs — lowercase words break them
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

    // Normalize apostrophes for closed-class lookup
    const lower = cleaned.toLowerCase().replace(/[\u2018\u2019\u02BC\u0060\u00B4\u2032'']/g, "'");

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

    // Non-capitalized or sentence-start word: flush current NP.
    // Only capitalized mid-sentence words form part of proper noun NPs —
    // lowercase content words (verbs, common nouns) are NP boundaries.
    if (current.length > 0) {
      candidates.push(current.join(" "));
      current = [];
    }
  }

  if (current.length > 0) {
    candidates.push(current.join(" "));
  }

  // Deduplicate, filter single-char, cap length, and validate quality
  const unique = [...new Set(candidates)].filter((c) => c.length > 1);
  return unique.filter(isValidNPCandidate);
}

/**
 * Validate that an NP candidate is a plausible proper noun, not a verb/garbage.
 */
function isValidNPCandidate(candidate: string): boolean {
  // Reject if contains brackets, pipes, or other non-name characters
  if (/[\[\]{}|<>#@\\~`]/.test(candidate)) return false;

  // Reject dash/special-only sequences
  if (/^[-—–\s_.]+$/.test(candidate)) return false;

  // Reject if it contains digits mixed with letters in a non-name pattern
  // (e.g., "B2", "M1" — but allow "District 9", "Sector 7G")
  if (/^[A-Z]\d/.test(candidate) && candidate.length <= 3) return false;

  // Cap at 5 words — longer sequences are almost certainly sentences
  const words = candidate.split(/\s+/);
  if (words.length > 5) return false;

  // Single-word: reject known verbs, expletives, adjectives
  if (words.length === 1) {
    if (SINGLE_WORD_REJECT.has(candidate.toLowerCase())) return false;
  }

  return true;
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
 * Handles roleplay-style formatting: strips HTML tags, asterisks, bracket artifacts, etc.
 */
export function tokenizeForNPChunker(content: string): string[] {
  // Strip HTML tags
  let cleaned = content.replace(/<[^>]+>/g, " ");
  // Strip roleplay action markers
  cleaned = cleaned.replace(/\*+/g, " ");
  // Strip chunk format prefix: [CHARACTER | Name]:
  cleaned = cleaned.replace(/^\s*\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/i, "");
  // Strip bracket content and orphaned brackets — proper nouns don't live in brackets
  cleaned = cleaned.replace(/\[[^\]]*\]/g, " ");
  cleaned = cleaned.replace(/[\[\]]/g, "");
  // Strip sequences of dashes/special chars (e.g., "---", "===")
  cleaned = cleaned.replace(/[-—–=]{2,}/g, " ");
  // Normalize apostrophes to standard single quote for contraction matching
  cleaned = cleaned.replace(/[\u2018\u2019\u02BC\u0060\u00B4\u2032'']/g, "'");
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
