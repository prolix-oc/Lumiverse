import type { WorldBookEntry } from "../types/world-book";
import type {
  EmbeddingConfig,
  WorldBookSearchCandidate,
} from "./embeddings.service";

type WorldBookEntryModel = WorldBookEntry;
type HybridWeightMode = EmbeddingConfig["hybrid_weight_mode"];

interface WorldInfoVectorRankingPreset {
  candidateMultiplier: number;
  weights: {
    vector: number;
    primaryExact: number;
    primaryPartial: number;
    secondaryExact: number;
    secondaryPartial: number;
    commentExact: number;
    commentPartial: number;
    priority: number;
    broadPenalty: number;
  };
}

interface PhraseSpecificityState {
  totalEntries: number;
  phraseDocFrequency: Map<string, number>;
  tokenDocFrequency: Map<string, number>;
}

interface VectorQueryLexicalState {
  normalizedText: string;
  tokenSet: Set<string>;
  focusTokenSet: Set<string>;
  specificityState: PhraseSpecificityState;
}

export interface VectorScoreBreakdown {
  vectorSimilarity: number;
  lexicalContentBoost: number;
  primaryExact: number;
  primaryPartial: number;
  secondaryExact: number;
  secondaryPartial: number;
  commentExact: number;
  commentPartial: number;
  focusBoost: number;
  priority: number;
  broadPenalty: number;
  focusMissPenalty: number;
}

export interface VectorActivatedEntry {
  entry: WorldBookEntryModel;
  score: number;
  distance: number;
  finalScore: number;
  lexicalCandidateScore: number | null;
  matchedPrimaryKeys: string[];
  matchedSecondaryKeys: string[];
  matchedComment: string | null;
  scoreBreakdown: VectorScoreBreakdown;
  searchTextPreview: string;
}

export type VectorRetrievalTraceStage =
  | "shortlisted"
  | "trimmed_by_top_k"
  | "rejected_by_rerank_cutoff"
  | "rejected_by_similarity_threshold";

export interface VectorRetrievalTraceEntry extends VectorActivatedEntry {
  retrievalStage: VectorRetrievalTraceStage;
  rerankRank: number | null;
}

export interface VectorCandidatePoolEntry {
  entry: WorldBookEntryModel;
  candidate: WorldBookSearchCandidate;
}

export interface VectorWorldInfoRankingInput {
  eligibleEntries: WorldBookEntryModel[];
  pooledCandidates: VectorCandidatePoolEntry[];
  queryText: string;
  hybridWeightMode: HybridWeightMode;
  similarityThreshold: number;
  rerankCutoff: number;
  topK: number;
}

export interface VectorWorldInfoRankingResult {
  shortlistedEntries: VectorActivatedEntry[];
  candidateTrace: VectorRetrievalTraceEntry[];
  hitsBeforeThreshold: number;
  hitsAfterThreshold: number;
  thresholdRejected: number;
  hitsAfterRerankCutoff: number;
  rerankRejected: number;
}

export interface VectorWorldInfoTimingBreakdown {
  queryBuildMs: number;
  queryEmbedMs: number;
  searchMs: number;
  rankingMs: number;
  totalMs: number;
}

export interface VectorWorldInfoRetrievalResult {
  entries: VectorActivatedEntry[];
  candidateTrace: VectorRetrievalTraceEntry[];
  queryPreview: string;
  eligibleCount: number;
  hitsBeforeThreshold: number;
  hitsAfterThreshold: number;
  thresholdRejected: number;
  hitsAfterRerankCutoff: number;
  rerankRejected: number;
  topK: number;
  cap: number;
  blockerMessages: string[];
  timingsMs?: VectorWorldInfoTimingBreakdown;
}

const WORLD_INFO_VECTOR_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "was",
  "were",
  "with",
  "you",
  "your",
]);

const WORLD_INFO_FOCUS_GENERIC_TOKENS = new Set([
  "angel",
  "angels",
  "demon",
  "demons",
  "king",
  "spirit",
  "spirits",
  "astral",
  "dress",
  "first",
  "true",
  "special",
  "service",
  "team",
  "unit",
  "force",
  "forces",
  "group",
  "protocol",
  "framework",
  "mechanics",
  "classification",
  "ranks",
  "rank",
  "codename",
  "operations",
  "operation",
  "alarm",
  "date",
  "goal",
  "goals",
  "state",
  "form",
  "city",
  "world",
  "public",
  "perception",
  "history",
  "arc",
  "post",
  "rules",
  "rule",
]);

const WORLD_INFO_REFERENCE_TITLE_KEYWORDS = new Set([
  "relationship",
  "protocol",
  "framework",
  "mechanics",
  "classification",
  "ranks",
  "rank",
  "codename",
  "perception",
  "alarm",
  "operations",
  "operation",
  "goal",
  "goals",
  "founders",
  "cooking",
  "conflict",
  "date",
  "post",
  "history",
  "arc",
]);

const WORLD_INFO_REFERENCE_CONTENT_PATTERNS = [
  /\brelationship\s*:/i,
  /\bsection_/i,
  /\bsubsection_/i,
  /\belement_/i,
  /\bframework_/i,
  /\bofficial_narrative\b/i,
  /\bnarrative_function\b/i,
  /\bgoal_&_philosophy\b/i,
  /\brule\s*:/i,
  /\boverview\(/i,
] as const;

const WORLD_INFO_SUBJECT_FIELD_PATTERNS = [
  /\b(?:user|wielder|owner|pilot|host|bearer|contractor)\(([^)]+)\)/gi,
] as const;

const WORLD_INFO_VECTOR_PRESETS: Record<
  HybridWeightMode,
  WorldInfoVectorRankingPreset
> = {
  keyword_first: {
    candidateMultiplier: 4,
    weights: {
      vector: 0.6,
      primaryExact: 0.7,
      primaryPartial: 0.3,
      secondaryExact: 0.4,
      secondaryPartial: 0.16,
      commentExact: 0.15,
      commentPartial: 0.055,
      priority: 0.08,
      broadPenalty: 0.05,
    },
  },
  balanced: {
    candidateMultiplier: 3,
    weights: {
      vector: 0.8,
      primaryExact: 0.55,
      primaryPartial: 0.24,
      secondaryExact: 0.28,
      secondaryPartial: 0.12,
      commentExact: 0.1,
      commentPartial: 0.035,
      priority: 0.06,
      broadPenalty: 0.07,
    },
  },
  vector_first: {
    candidateMultiplier: 2,
    weights: {
      vector: 1,
      primaryExact: 0.42,
      primaryPartial: 0.16,
      secondaryExact: 0.18,
      secondaryPartial: 0.08,
      commentExact: 0.07,
      commentPartial: 0.02,
      priority: 0.04,
      broadPenalty: 0.08,
    },
  },
};

function incrementFrequency(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function buildPhraseSpecificityState(
  entries: WorldBookEntryModel[],
): PhraseSpecificityState {
  const phraseDocFrequency = new Map<string, number>();
  const tokenDocFrequency = new Map<string, number>();

  for (const entry of entries) {
    const keys = entry.key;
    const secondaries = entry.keysecondary;
    const comment = entry.comment;
    const hasKeys = keys && keys.length > 0;
    const hasSecondaries = secondaries && secondaries.length > 0;
    const hasComment = !!(comment && comment.length > 0);
    if (!hasKeys && !hasSecondaries && !hasComment) continue;

    const entryPhrases = new Set<string>();
    const entryTokens = new Set<string>();

    const ingest = (value: string) => {
      const normalizedValue = normalizeLexicalText(value);
      if (!normalizedValue) return;
      entryPhrases.add(normalizedValue);
      for (const token of tokenizeLexicalText(value)) {
        entryTokens.add(token);
      }
    };

    if (hasKeys) for (const value of keys) ingest(value);
    if (hasSecondaries) for (const value of secondaries) ingest(value);
    if (hasComment) ingest(comment);

    for (const phrase of entryPhrases) {
      incrementFrequency(phraseDocFrequency, phrase);
    }

    for (const token of entryTokens) {
      incrementFrequency(tokenDocFrequency, token);
    }
  }

  return {
    totalEntries: Math.max(1, entries.length),
    phraseDocFrequency,
    tokenDocFrequency,
  };
}

function normalizeLexicalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLexicalText(text: string): string[] {
  return normalizeLexicalText(text)
    .split(" ")
    .filter(
      (token) => token.length > 1 && !WORLD_INFO_VECTOR_STOPWORDS.has(token),
    );
}

function dedupeStringsCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function hasExactPhraseMatch(normalizedText: string, value: string): boolean {
  const normalizedValue = normalizeLexicalText(value);
  if (!normalizedText || !normalizedValue) return false;
  return ` ${normalizedText} `.includes(` ${normalizedValue} `);
}

function getPhraseTokenOverlap(tokenSet: Set<string>, value: string): number {
  const tokens = tokenizeLexicalText(value);
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) matched += 1;
  }
  return matched / tokens.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distanceToSimilarity(distance: number): number {
  return Math.exp(-1.5 * Math.max(0, distance));
}

function getInverseFrequencyScore(
  totalEntries: number,
  documentFrequency: number,
): number {
  if (totalEntries <= 1) return 1;
  const clampedFrequency = Math.max(
    1,
    Math.min(documentFrequency, totalEntries),
  );
  return clamp01(
    Math.log((totalEntries + 1) / clampedFrequency) /
      Math.log(totalEntries + 1),
  );
}

function getTokenSpecificity(
  state: PhraseSpecificityState,
  token: string,
): number {
  return getInverseFrequencyScore(
    state.totalEntries,
    state.tokenDocFrequency.get(token) ?? state.totalEntries,
  );
}

function getPhraseSpecificity(
  state: PhraseSpecificityState,
  value: string,
): number {
  const normalizedValue = normalizeLexicalText(value);
  if (!normalizedValue) return 0;

  const tokens = tokenizeLexicalText(value);
  if (tokens.length === 0) return 0;

  const phraseSpecificity = getInverseFrequencyScore(
    state.totalEntries,
    state.phraseDocFrequency.get(normalizedValue) ?? state.totalEntries,
  );
  const tokenSpecificity =
    tokens.reduce(
      (sum, token) =>
        sum +
        getInverseFrequencyScore(
          state.totalEntries,
          state.tokenDocFrequency.get(token) ?? state.totalEntries,
        ),
      0,
    ) / tokens.length;

  const baseSpecificity =
    tokens.length === 1
      ? tokenSpecificity
      : phraseSpecificity * 0.55 + tokenSpecificity * 0.45;
  const tokenCountFactor =
    tokens.length >= 3 ? 1 : tokens.length === 2 ? 0.94 : 0.82;
  const lengthFactor =
    normalizedValue.length >= 10
      ? 1
      : normalizedValue.length >= 6
        ? 0.92
        : 0.84;

  return clamp01(
    Math.max(0.08, baseSpecificity * tokenCountFactor * lengthFactor),
  );
}

function getPhraseSignalStrength(
  specificity: number,
  value: string,
  kind: "key" | "comment",
): number {
  const normalizedValue = normalizeLexicalText(value);
  if (!normalizedValue || specificity <= 0) return 0;

  const tokenCount = tokenizeLexicalText(value).length;
  if (tokenCount !== 1) return specificity;

  const lengthFactor =
    normalizedValue.length >= 11
      ? 0.92
      : normalizedValue.length >= 8
        ? 0.82
        : 0.72;
  const rarityFactor =
    kind === "comment" ? 0.32 + specificity * 0.58 : 0.4 + specificity * 0.5;
  const kindFactor = kind === "comment" ? 0.74 : 0.8;

  return clamp01(specificity * lengthFactor * rarityFactor * kindFactor);
}

function getPartialMatchThreshold(
  value: string,
  kind: "key" | "comment",
): number {
  const tokenCount = tokenizeLexicalText(value).length;
  if (tokenCount <= 1) return 1;
  if (kind === "comment") return tokenCount === 2 ? 0.85 : 0.75;
  return tokenCount === 2 ? 0.75 : 0.6;
}

function getRareTokenPartialScore(
  value: string,
  queryState: VectorQueryLexicalState,
  partialWeight: number,
  kind: "key" | "comment",
): number {
  const tokens = Array.from(new Set(tokenizeLexicalText(value)));
  if (tokens.length < 2) return 0;

  const matchedTokenSpecificities = tokens
    .filter((token) => queryState.tokenSet.has(token))
    .map((token) => getTokenSpecificity(queryState.specificityState, token));
  if (matchedTokenSpecificities.length === 0) return 0;

  const bestTokenSpecificity = Math.max(...matchedTokenSpecificities);
  const minimumSpecificity = kind === "comment" ? 0.42 : 0.34;
  if (bestTokenSpecificity < minimumSpecificity) return 0;

  const averageMatchedSpecificity =
    matchedTokenSpecificities.reduce(
      (sum, specificity) => sum + specificity,
      0,
    ) / matchedTokenSpecificities.length;
  const matchedCoverage = matchedTokenSpecificities.length / tokens.length;
  const coverageFactor = 0.48 + matchedCoverage * 0.52;
  const shapeFactor =
    tokens.length === 2 ? 0.92 : tokens.length === 3 ? 0.88 : 0.84;

  return (
    partialWeight *
    (bestTokenSpecificity * 0.72 + averageMatchedSpecificity * 0.28) *
    coverageFactor *
    shapeFactor
  );
}

function countPatternMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches?.length ?? 0;
}

function estimateReferenceEntryPenalty(
  entry: WorldBookEntryModel,
  candidateDistance: number,
  lexicalSpecificityAnchor: number,
  primaryMatches: { exactScore: number; partialScore: number },
  secondaryMatches: { exactScore: number; partialScore: number },
  commentMatches: { exactScore: number; partialScore: number },
): number {
  const content = entry.content || "";
  const title = entry.comment || "";
  const titleTokens = tokenizeLexicalText(title);
  const contentTokenCount = tokenizeLexicalText(content).length;
  const titleTokenCount = titleTokens.length;
  const fieldPatternCount = countPatternMatches(
    content,
    /\b[a-z][a-z0-9_]{2,}\s*\(/gi,
  );
  const semicolonCount = countPatternMatches(content, /;/g);
  const listMarkerCount = countPatternMatches(content, /^\s*[-*]/gm);

  const lengthPenalty = clamp01((contentTokenCount - 90) / 260);
  const structurePenalty = clamp01(
    clamp01(fieldPatternCount / 14) * 0.55 +
      clamp01(semicolonCount / 22) * 0.35 +
      clamp01(listMarkerCount / 8) * 0.1,
  );
  const singleTokenTitlePenalty = titleTokenCount === 1 ? 0.08 : 0;
  const hasKeyMatch =
    primaryMatches.exactScore > 0 ||
    primaryMatches.partialScore > 0 ||
    secondaryMatches.exactScore > 0 ||
    secondaryMatches.partialScore > 0;
  const hasCommentMatch =
    commentMatches.exactScore > 0 || commentMatches.partialScore > 0;
  const commentOnlyMatch = hasCommentMatch && !hasKeyMatch;
  const referenceKeywordCount = titleTokens.filter((token) =>
    WORLD_INFO_REFERENCE_TITLE_KEYWORDS.has(token),
  ).length;
  const relationshipStyleTitle =
    /[&/]/.test(title) ||
    /\brelationship\b/i.test(title) ||
    /\brelationship\s*:/i.test(content);
  const parentheticalMetaTitle = /\((angel|demon king|form|state)\)/i.test(
    title,
  );
  const acronymTitle = /\b[A-Z]{2,}\b/.test(title);
  const referenceContentSignalCount =
    WORLD_INFO_REFERENCE_CONTENT_PATTERNS.reduce(
      (count, pattern) => count + (pattern.test(content) ? 1 : 0),
      0,
    );
  const vectorWeakness = clamp01((candidateDistance - 0.9) / 0.45);
  const lexicalConfidence = clamp01(
    lexicalSpecificityAnchor * 0.68 +
      (commentMatches.exactScore > 0 ? 0.08 : 0) +
      (primaryMatches.exactScore > 0 ? 0.18 : 0) +
      (secondaryMatches.exactScore > 0 ? 0.12 : 0) +
      (commentMatches.partialScore > 0 ? 0.04 : 0) +
      (primaryMatches.partialScore > 0 ? 0.08 : 0) +
      (secondaryMatches.partialScore > 0 ? 0.05 : 0),
  );
  const titleMetaPenalty = hasCommentMatch
    ? clamp01(
        (relationshipStyleTitle ? 1 : 0) * 0.9 +
          clamp01(referenceKeywordCount / 2) * 0.48 +
          clamp01(referenceContentSignalCount / 3) * 0.34,
      ) *
      (commentOnlyMatch ? 1 : 0.45) *
      (0.3 + vectorWeakness * 0.7) *
      (commentMatches.exactScore > 0 ? 1 : 0.82)
    : 0;
  const structurePenaltyWithConfidence =
    clamp01(
      lengthPenalty * 0.3 + structurePenalty * 0.6 + singleTokenTitlePenalty,
    ) *
    (1 - lexicalConfidence);
  const titlePenaltyWithConfidence =
    titleMetaPenalty * Math.max(0.18, 0.72 - lexicalConfidence * 0.32);
  const relationshipPenalty = relationshipStyleTitle
    ? (commentMatches.exactScore > 0 ? 0.04 : 0.026) *
      (commentOnlyMatch ? 1 : 0.65) *
      (0.35 + vectorWeakness * 0.65)
    : 0;
  const parentheticalMetaPenalty =
    parentheticalMetaTitle && !hasKeyMatch
      ? (commentMatches.partialScore > 0 && commentMatches.exactScore === 0
          ? 0.028
          : 0.014) *
        (commentOnlyMatch ? 1 : 0.75) *
        (0.28 + vectorWeakness * 0.72)
      : 0;
  const acronymPenalty =
    acronymTitle && !hasKeyMatch && !hasCommentMatch
      ? 0.02 + vectorWeakness * 0.035
      : 0;

  return clamp01(
    structurePenaltyWithConfidence +
      titlePenaltyWithConfidence +
      relationshipPenalty +
      parentheticalMetaPenalty +
      acronymPenalty,
  );
}

function buildFocusTokenSet(
  queryText: string,
  specificityState: PhraseSpecificityState,
): Set<string> {
  const queryTokenSignals = new Map<
    string,
    { count: number; hasNameLikeForm: boolean; hasUppercaseForm: boolean }
  >();
  for (const match of queryText.matchAll(/\b[A-Za-z0-9]+\b/g)) {
    const rawToken = match[0];
    const normalizedToken = normalizeLexicalText(rawToken);
    if (
      !normalizedToken ||
      WORLD_INFO_VECTOR_STOPWORDS.has(normalizedToken) ||
      normalizedToken.length <= 1
    ) {
      continue;
    }

    const previous = queryTokenSignals.get(normalizedToken) ?? {
      count: 0,
      hasNameLikeForm: false,
      hasUppercaseForm: false,
    };
    const isUppercaseForm =
      /[A-Z]/.test(rawToken) && rawToken === rawToken.toUpperCase();
    const isNameLikeForm = isUppercaseForm || /^[A-Z][a-z0-9]+$/.test(rawToken);

    queryTokenSignals.set(normalizedToken, {
      count: previous.count + 1,
      hasNameLikeForm: previous.hasNameLikeForm || isNameLikeForm,
      hasUppercaseForm: previous.hasUppercaseForm || isUppercaseForm,
    });
  }

  const tokens = tokenizeLexicalText(queryText);
  return new Set(
    tokens.filter((token) => {
      if (!token || WORLD_INFO_FOCUS_GENERIC_TOKENS.has(token)) return false;

      const signal = queryTokenSignals.get(token);
      if (!signal) return false;

      const specificity = getTokenSpecificity(specificityState, token);
      const repeated = signal.count >= 2 && token.length >= 4;
      const named = signal.hasNameLikeForm && token.length >= 3;
      const uppercase = signal.hasUppercaseForm && token.length >= 2;
      const verySpecificLongToken = token.length >= 8 && specificity >= 0.48;

      if (uppercase) return true;
      if (named && specificity >= 0.24) return true;
      if (repeated && specificity >= 0.3) return true;
      if (verySpecificLongToken) return true;
      return false;
    }),
  );
}

function getEntryFocusOverlap(
  entry: WorldBookEntryModel,
  queryState: VectorQueryLexicalState,
): { count: number; score: number } {
  if (queryState.focusTokenSet.size === 0) {
    return { count: 0, score: 0 };
  }

  const title = entry.comment || "";
  const content = entry.content || "";
  const titleTokens = tokenizeLexicalText(title);
  const referenceKeywordCount = titleTokens.filter((token) =>
    WORLD_INFO_REFERENCE_TITLE_KEYWORDS.has(token),
  ).length;
  const relationshipStyleTitle =
    /[&/]/.test(title) ||
    /\brelationship\b/i.test(title) ||
    /\brelationship\s*:/i.test(content);
  const parentheticalMetaTitle = /\((angel|demon king|form|state)\)/i.test(
    title,
  );
  const referenceContentSignalCount =
    WORLD_INFO_REFERENCE_CONTENT_PATTERNS.reduce(
      (count, pattern) => count + (pattern.test(content) ? 1 : 0),
      0,
    );

  const entryTokens = new Set<string>();
  const lexicalValues = [
    ...(entry.key || []),
    ...(entry.keysecondary || []),
    title,
  ];

  for (const value of lexicalValues) {
    for (const token of tokenizeLexicalText(value)) {
      if (WORLD_INFO_FOCUS_GENERIC_TOKENS.has(token)) continue;
      entryTokens.add(token);
    }
  }

  const matchedSpecificities: number[] = [];
  for (const token of entryTokens) {
    if (!queryState.focusTokenSet.has(token)) continue;
    matchedSpecificities.push(
      getTokenSpecificity(queryState.specificityState, token),
    );
  }

  if (matchedSpecificities.length === 0) {
    return { count: 0, score: 0 };
  }

  const isReferenceStyleEntry =
    relationshipStyleTitle ||
    parentheticalMetaTitle ||
    referenceKeywordCount > 0 ||
    referenceContentSignalCount > 0;
  const bestSpecificity = Math.max(...matchedSpecificities);
  if (matchedSpecificities.length === 1 && bestSpecificity < 0.58) {
    return { count: 0, score: 0 };
  }

  const averageSpecificity =
    matchedSpecificities.reduce((sum, value) => sum + value, 0) /
    matchedSpecificities.length;
  const coverage =
    matchedSpecificities.length / Math.min(3, queryState.focusTokenSet.size);
  const rawScore = clamp01(
    (bestSpecificity * 0.62 + averageSpecificity * 0.38) *
      (0.45 + clamp01(coverage) * 0.55),
  );

  if (isReferenceStyleEntry) {
    return {
      count: matchedSpecificities.length,
      score: 0,
    };
  }

  return {
    count: matchedSpecificities.length,
    score: rawScore,
  };
}

function getEntryMetaCommentMultiplier(entry: WorldBookEntryModel): number {
  const title = entry.comment || "";
  const content = entry.content || "";
  const titleTokens = tokenizeLexicalText(title);
  const referenceKeywordCount = titleTokens.filter((token) =>
    WORLD_INFO_REFERENCE_TITLE_KEYWORDS.has(token),
  ).length;
  const relationshipStyleTitle =
    /[&/]/.test(title) ||
    /\brelationship\b/i.test(title) ||
    /\brelationship\s*:/i.test(content);
  const parentheticalMetaTitle = /\((angel|demon king|form|state)\)/i.test(
    title,
  );
  const referenceContentSignalCount =
    WORLD_INFO_REFERENCE_CONTENT_PATTERNS.reduce(
      (count, pattern) => count + (pattern.test(content) ? 1 : 0),
      0,
    );

  let multiplier = 1;
  if (relationshipStyleTitle) multiplier = Math.min(multiplier, 0.18);
  if (referenceKeywordCount > 0) multiplier = Math.min(multiplier, 0.35);
  if (referenceContentSignalCount > 0) multiplier = Math.min(multiplier, 0.42);
  if (parentheticalMetaTitle) multiplier = Math.min(multiplier, 0.7);
  return multiplier;
}

function getEntrySubjectMismatchPenalty(
  entry: WorldBookEntryModel,
  queryState: VectorQueryLexicalState,
  candidateDistance: number,
): number {
  const content = entry.content || "";
  const subjectTokens = new Set<string>();

  for (const pattern of WORLD_INFO_SUBJECT_FIELD_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const fieldValue = match[1] || "";
      for (const token of tokenizeLexicalText(fieldValue)) {
        if (WORLD_INFO_FOCUS_GENERIC_TOKENS.has(token)) continue;
        if (token.length < 3) continue;
        subjectTokens.add(token);
      }
    }
  }

  if (subjectTokens.size === 0) return 0;
  for (const token of subjectTokens) {
    if (queryState.tokenSet.has(token)) return 0;
  }

  const vectorWeakness = clamp01((candidateDistance - 0.9) / 0.45);
  return 0.038 + vectorWeakness * 0.024;
}

function scorePhraseMatches(
  values: string[],
  queryState: VectorQueryLexicalState,
  exactWeight: number,
  partialWeight: number,
  kind: "key" | "comment",
  maxExactMatches = 2,
): {
  exactScore: number;
  partialScore: number;
  matchedValues: string[];
  bestSpecificity: number;
  matchedSpecificity: number;
} {
  const exactSpecificities: number[] = [];
  const matchedValues: string[] = [];
  let partialScore = 0;
  let bestSpecificity = 0;
  let matchedSpecificity = 0;

  for (const value of values) {
    const rawSpecificity = getPhraseSpecificity(
      queryState.specificityState,
      value,
    );
    const specificity = getPhraseSignalStrength(rawSpecificity, value, kind);
    if (specificity <= 0) continue;

    bestSpecificity = Math.max(bestSpecificity, specificity);

    if (hasExactPhraseMatch(queryState.normalizedText, value)) {
      exactSpecificities.push(specificity);
      matchedValues.push(value);
      matchedSpecificity = Math.max(matchedSpecificity, specificity);
      continue;
    }

    const overlap = getPhraseTokenOverlap(queryState.tokenSet, value);
    if (overlap >= getPartialMatchThreshold(value, kind)) {
      matchedValues.push(value);
      matchedSpecificity = Math.max(matchedSpecificity, specificity);
      partialScore = Math.max(
        partialScore,
        overlap * specificity * partialWeight,
      );
      continue;
    }

    const rareTokenPartialScore = getRareTokenPartialScore(
      value,
      queryState,
      partialWeight,
      kind,
    );
    if (rareTokenPartialScore <= 0) continue;

    matchedValues.push(value);
    matchedSpecificity = Math.max(matchedSpecificity, specificity);
    partialScore = Math.max(partialScore, rareTokenPartialScore);
  }

  exactSpecificities.sort((a, b) => b - a);
  const exactScore = exactSpecificities
    .slice(0, maxExactMatches)
    .reduce(
      (sum, specificity, index) =>
        sum + specificity * exactWeight * (index === 0 ? 1 : 0.55),
      0,
    );

  return {
    exactScore,
    partialScore,
    matchedValues: dedupeStringsCaseInsensitive(matchedValues),
    bestSpecificity,
    matchedSpecificity,
  };
}

function buildVectorQueryLexicalState(
  queryText: string,
  specificityState: PhraseSpecificityState,
): VectorQueryLexicalState {
  return {
    normalizedText: normalizeLexicalText(queryText),
    tokenSet: new Set(tokenizeLexicalText(queryText)),
    focusTokenSet: buildFocusTokenSet(queryText, specificityState),
    specificityState,
  };
}

function getWorldInfoVectorPreset(
  mode: HybridWeightMode,
): WorldInfoVectorRankingPreset {
  return WORLD_INFO_VECTOR_PRESETS[mode] ?? WORLD_INFO_VECTOR_PRESETS.balanced;
}

export function getWorldInfoVectorCandidateMultiplier(
  mode: HybridWeightMode,
): number {
  return getWorldInfoVectorPreset(mode).candidateMultiplier;
}

function scoreVectorWorldInfoCandidate(
  entry: WorldBookEntryModel,
  candidate: WorldBookSearchCandidate,
  queryState: VectorQueryLexicalState,
  preset: WorldInfoVectorRankingPreset,
): VectorActivatedEntry {
  const primaryMatches = scorePhraseMatches(
    entry.key || [],
    queryState,
    preset.weights.primaryExact,
    preset.weights.primaryPartial,
    "key",
  );
  const secondaryMatches = scorePhraseMatches(
    entry.keysecondary || [],
    queryState,
    preset.weights.secondaryExact,
    preset.weights.secondaryPartial,
    "key",
  );

  const comment = (entry.comment || "").trim();
  const rawCommentMatches = comment
    ? scorePhraseMatches(
        [comment],
        queryState,
        preset.weights.commentExact,
        preset.weights.commentPartial,
        "comment",
        1,
      )
    : {
        exactScore: 0,
        partialScore: 0,
        matchedValues: [],
        bestSpecificity: 0,
        matchedSpecificity: 0,
      };
  const commentMultiplier = getEntryMetaCommentMultiplier(entry);
  const commentMatches = {
    ...rawCommentMatches,
    exactScore: rawCommentMatches.exactScore * commentMultiplier,
    partialScore: rawCommentMatches.partialScore * commentMultiplier,
    bestSpecificity: rawCommentMatches.bestSpecificity * commentMultiplier,
    matchedSpecificity:
      rawCommentMatches.matchedSpecificity * commentMultiplier,
  };
  const matchedComment = rawCommentMatches.matchedValues[0] ?? null;

  const isFtsOnly = !Number.isFinite(candidate.distance);
  const vectorSimilarity = distanceToSimilarity(
    isFtsOnly ? 2 : candidate.distance,
  );
  const primaryExactScore = primaryMatches.exactScore;
  const primaryPartialScore = primaryMatches.partialScore;
  const secondaryExactScore = secondaryMatches.exactScore;
  const secondaryPartialScore = secondaryMatches.partialScore;
  const commentExactScore = commentMatches.exactScore;
  const commentPartialScore = commentMatches.partialScore;
  const focusOverlap = getEntryFocusOverlap(entry, queryState);
  const focusBoost = focusOverlap.score * 0.05;
  const priorityScore =
    clamp01((entry.priority || 0) / 100) * preset.weights.priority;
  const vectorScore = vectorSimilarity * preset.weights.vector;
  const lexicalContentBoost =
    candidate.lexical_score != null && candidate.lexical_score > 0
      ? clamp01(Math.log1p(candidate.lexical_score) / Math.log1p(30)) *
        preset.weights.vector *
        0.35
      : 0;
  const lexicalSpecificityAnchor = Math.max(
    primaryMatches.matchedSpecificity,
    secondaryMatches.matchedSpecificity,
    commentMatches.matchedSpecificity,
  );
  const entrySpecificityAnchor = Math.max(
    lexicalSpecificityAnchor,
    commentMatches.bestSpecificity * 0.7,
    primaryMatches.bestSpecificity * 0.45,
    secondaryMatches.bestSpecificity * 0.35,
  );
  const lexicalSignalStrength =
    primaryExactScore +
    primaryPartialScore +
    secondaryExactScore +
    secondaryPartialScore +
    commentExactScore +
    commentPartialScore;
  const effectiveDistance = isFtsOnly ? 2 : candidate.distance;
  const ftsWeaknessReduction =
    isFtsOnly && lexicalContentBoost > 0
      ? clamp01(lexicalContentBoost / (preset.weights.vector * 0.35)) * 0.45
      : 0;
  const vectorWeakness = clamp01(
    (effectiveDistance - 0.92) / 0.45 - ftsWeaknessReduction,
  );
  const baseBroadPenalty =
    clamp01(1 - entrySpecificityAnchor) *
    preset.weights.broadPenalty *
    (lexicalSpecificityAnchor > 0 ? 0.25 : 0.9);
  const referencePenalty =
    estimateReferenceEntryPenalty(
      entry,
      effectiveDistance,
      lexicalSpecificityAnchor,
      primaryMatches,
      secondaryMatches,
      commentMatches,
    ) *
    preset.weights.broadPenalty *
    0.95;
  const focusMissPenalty =
    focusOverlap.count === 0
      ? (0.018 + vectorWeakness * 0.028) *
        (lexicalSignalStrength > 0.02 ? 0.55 : 1) *
        (queryState.focusTokenSet.size > 0 ? 1 : 0)
      : 0;
  const subjectMismatchPenalty = getEntrySubjectMismatchPenalty(
    entry,
    queryState,
    effectiveDistance,
  );
  const broadPenalty =
    baseBroadPenalty +
    referencePenalty +
    focusMissPenalty +
    subjectMismatchPenalty;

  const finalScore = Math.max(
    0,
    vectorScore +
      lexicalContentBoost +
      primaryExactScore +
      primaryPartialScore +
      secondaryExactScore +
      secondaryPartialScore +
      commentExactScore +
      commentPartialScore +
      focusBoost +
      priorityScore -
      broadPenalty,
  );

  return {
    entry,
    score: finalScore,
    distance: candidate.distance,
    finalScore,
    lexicalCandidateScore: candidate.lexical_score,
    matchedPrimaryKeys: primaryMatches.matchedValues,
    matchedSecondaryKeys: secondaryMatches.matchedValues,
    matchedComment,
    scoreBreakdown: {
      vectorSimilarity: vectorScore,
      lexicalContentBoost,
      primaryExact: primaryExactScore,
      primaryPartial: primaryPartialScore,
      secondaryExact: secondaryExactScore,
      secondaryPartial: secondaryPartialScore,
      commentExact: commentExactScore,
      commentPartial: commentPartialScore,
      focusBoost,
      priority: priorityScore,
      broadPenalty,
      focusMissPenalty,
    },
    searchTextPreview: candidate.searchTextPreview,
  };
}

export function rankVectorWorldInfoCandidates(
  input: VectorWorldInfoRankingInput,
): VectorWorldInfoRankingResult {
  const {
    eligibleEntries,
    pooledCandidates,
    queryText,
    hybridWeightMode,
    similarityThreshold,
    rerankCutoff,
    topK,
  } = input;
  const preset = getWorldInfoVectorPreset(hybridWeightMode);
  const hitsBeforeThreshold = pooledCandidates.length;
  const specificityState = buildPhraseSpecificityState(eligibleEntries);
  const queryState = buildVectorQueryLexicalState(queryText, specificityState);
  const scoredCandidates = pooledCandidates.map(({ entry, candidate }) =>
    scoreVectorWorldInfoCandidate(entry, candidate, queryState, preset),
  );
  const thresholdPassed =
    similarityThreshold > 0
      ? scoredCandidates.filter((item) => {
          if (!Number.isFinite(item.distance)) return item.finalScore > 0;
          return item.distance <= similarityThreshold;
        })
      : scoredCandidates;
  const thresholdRejectedCandidates =
    similarityThreshold > 0
      ? scoredCandidates.filter((item) => {
          if (!Number.isFinite(item.distance)) return item.finalScore <= 0;
          return item.distance > similarityThreshold;
        })
      : [];
  const hitsAfterThreshold = thresholdPassed.length;
  const thresholdRejected = hitsBeforeThreshold - hitsAfterThreshold;
  thresholdPassed.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (b.entry.priority !== a.entry.priority)
      return b.entry.priority - a.entry.priority;
    return a.entry.order_value - b.entry.order_value;
  });

  const rerankFiltered =
    rerankCutoff > 0
      ? thresholdPassed.filter((item) => item.finalScore >= rerankCutoff)
      : thresholdPassed;
  const rerankRejectedCandidates =
    rerankCutoff > 0
      ? thresholdPassed.filter((item) => item.finalScore < rerankCutoff)
      : [];
  const hitsAfterRerankCutoff = rerankFiltered.length;
  const rerankRejected = thresholdPassed.length - hitsAfterRerankCutoff;

  const shortlistedEntries = rerankFiltered.slice(0, topK);
  const topKTrimmedEntries = rerankFiltered.slice(topK);
  const rerankRankById = new Map<string, number>(
    thresholdPassed.map((item, index) => [item.entry.id, index + 1]),
  );
  const candidateTrace: VectorRetrievalTraceEntry[] = [
    ...shortlistedEntries.map((item) => ({
      ...item,
      retrievalStage: "shortlisted" as const,
      rerankRank: rerankRankById.get(item.entry.id) ?? null,
    })),
    ...topKTrimmedEntries.map((item) => ({
      ...item,
      retrievalStage: "trimmed_by_top_k" as const,
      rerankRank: rerankRankById.get(item.entry.id) ?? null,
    })),
    ...rerankRejectedCandidates.map((item) => ({
      ...item,
      retrievalStage: "rejected_by_rerank_cutoff" as const,
      rerankRank: rerankRankById.get(item.entry.id) ?? null,
    })),
    ...thresholdRejectedCandidates
      .sort((a, b) => a.distance - b.distance)
      .map((item) => ({
        ...item,
        retrievalStage: "rejected_by_similarity_threshold" as const,
        rerankRank: null,
      })),
  ];

  return {
    shortlistedEntries,
    candidateTrace,
    hitsBeforeThreshold,
    hitsAfterThreshold,
    thresholdRejected,
    hitsAfterRerankCutoff,
    rerankRejected,
  };
}
