/**
 * Memory Cortex — Configuration and settings resolution.
 *
 * The cortex operates at three progressive tiers:
 *   Tier 0: Existing chat_chunks + LanceDB (no cortex involvement)
 *   Tier 1: Heuristic entity extraction + salience scoring (no sidecar needed)
 *   Tier 2: Sidecar-enhanced extraction, scoring, and consolidation
 *
 * v2: Addresses community feedback:
 *   - Three user-facing presets: Simple, Standard, Advanced
 *   - Core memory protection: high-salience memories exempt from decay
 *   - Configurable entity whitelist for fantasy proper nouns
 *   - Entity pruning configuration
 */

import * as settingsSvc from "../settings.service";
import {
  getDefaultEntityExtractionFilters,
  normalizeEntityExtractionFilters,
  type MemoryEntityExtractionFilters,
} from "./entity-extraction-filters";

const SETTINGS_KEY = "memoryCortexConfig";

// ─── User-Facing Preset Mode ───────────────────────────────────

/**
 * Preset modes hide complexity behind a single selector.
 *   "simple"   — One toggle. Entity tracking + salience on, everything else defaults.
 *   "standard" — Entities + salience + emotional resonance + relationships.
 *   "advanced" — Full control over all parameters.
 *   null       — Raw config (for API / migration compatibility).
 */
export type CortexPresetMode = "simple" | "standard" | "advanced" | null;

// ─── Configuration Shape ───────────────────────────────────────

export interface ConsolidationConfig {
  enabled: boolean;
  /** Unconsolidated chunk count before consolidation fires */
  chunkThreshold: number;
  /** Chunks consumed per consolidation summary */
  chunksPerConsolidation: number;
  /** Tier-1 consolidation count before arc-level fires */
  arcThreshold: number;
  /** Use sidecar LLM for summaries (false = extractive) */
  useSidecar: boolean;
  /** Max tokens per generated summary */
  maxTokensPerSummary: number;
}

export interface SidecarReliabilityConfig {
  /** What to do when the sidecar fails after exhausting retries.
   *  - "heuristic": persist heuristic output for this chunk (legacy behavior).
   *    Heuristic salience/entities/relations leak into the graph even though the
   *    user asked for sidecar-quality results.
   *  - "skip": do not persist anything for this chunk and do not mark its
   *    warmup signature. The next cortex warmup re-processes it. Equivalent to
   *    the "AI Only" mode users have asked for. */
  fallback: "heuristic" | "skip";
  /** Additional sidecar attempts after the first call (0 = no retry, legacy). */
  maxRetries: number;
  /** Base backoff in ms between sidecar attempts. Doubled per retry. */
  retryDelayMs: number;
  /** When true and the sidecar succeeded, the sidecar judges heuristic entities
   *  and relationships extracted for this chunk: rejected heuristics are
   *  dropped, transformed ones are renamed to the sidecar's canonical form
   *  before merging. */
  arbitratesHeuristics: boolean;
  /** When true and the sidecar marks an *existing* graph entity as invalid for
   *  this chunk's context, that entity is removed from the graph (mentions and
   *  relations included). User-edited entities are preserved regardless of
   *  sidecar grading. */
  gradesExistingRecords: boolean;
}

export interface FactManagementConfig {
  /** Minimum chunk importance (0–10) required for facts to be persisted.
   *  Chunks scoring below this threshold contribute no facts. Default: 3. */
  importanceThreshold: number;
  /** Maximum facts stored per entity. When exceeded, lowest-importance facts
   *  are trimmed first. Default: 30. */
  maxFactsPerEntity: number;
  /** When true and the sidecar is active, exceeding maxFactsPerEntity triggers
   *  an LLM call to curate which facts to keep/merge/discard instead of
   *  purely score-based trimming. ("Fact Auto-Pilot") Default: false. */
  autopilot: boolean;
}

export interface ThoughtMarkerConfig {
  /** Prefix marking a character thought block, e.g. <thinking> */
  prefix: string;
  /** Suffix marking a character thought block, e.g. </thinking> */
  suffix: string;
}

export interface MemoryCortexConfig {
  /** Master switch — disabling preserves all data but skips cortex retrieval */
  enabled: boolean;

  /** Automatically warm cortex state when a chat is opened */
  autoWarmup: boolean;

  /** Active preset mode (controls which settings are visible in UI) */
  presetMode: CortexPresetMode;

  /** Build and maintain the entity graph */
  entityTracking: boolean;
  /** Entity extraction strategy */
  entityExtractionMode: "heuristic" | "sidecar" | "off";

  /** Optional custom delimiters for character thought text in chat content */
  thoughtMarkers: ThoughtMarkerConfig;

  /** Score chunk importance */
  salienceScoring: boolean;
  /** Salience scoring strategy */
  salienceScoringMode: "heuristic" | "sidecar";

  /** Hierarchical memory compression */
  consolidation: ConsolidationConfig;

  /** Sidecar LLM connection for Tier 2 features */
  sidecar: {
    /** Connection profile ID (null = use shared sidecar, or fall back to heuristic) */
    connectionProfileId: string | null;
    /** Model override (null = use connection profile's default model) */
    model: string | null;
    /** Sampling temperature */
    temperature: number;
    /** Top-P nucleus sampling */
    topP: number;
    /** Max tokens per sidecar call (auto-set by preset, user can override) */
    maxTokens: number;
    /** Chunks to analyze per LLM call (batched into a single prompt) */
    chunkBatchSize: number;
    /** Max parallel LLM requests during rebuild */
    rebuildConcurrency: number;
    /** Max sidecar requests started per minute for the selected provider. 0 disables gating. */
    requestsPerMinute: number;
  };

  /** How cortex data is formatted for LLM injection */
  formatterMode: "shadow" | "attributed" | "clinical" | "minimal";
  /** Render the Long-Term Memory block with the user's chat memory templates */
  useChatMemoryFormatting: boolean;
  /** Max tokens for all cortex-injected content */
  contextTokenBudget: number;

  /** Max milliseconds to wait for cortex retrieval during prompt assembly.
   *  If exceeded, generation falls back to plain vector search instead of stalling.
   *  0 = no timeout (not recommended). Default: 60000 (60s). */
  retrievalTimeoutMs: number;
  /** Max milliseconds to wait for a sidecar LLM call (chunk ingestion,
   *  consolidation). Prevents fire-and-forget promises from hanging indefinitely.
   *  Set higher for thinking/reasoning models that need extended processing time.
   *  0 = no timeout. Default: 60000 (60s). */
  sidecarTimeoutMs: number;

  /** Sidecar reliability + arbitration policy. Controls what happens when the
   *  sidecar fails, and how its output relates to heuristic candidates and
   *  existing graph records on success.
   *
   *  See SidecarReliabilityConfig for field-level docs.
   */
  sidecarReliability: SidecarReliabilityConfig;

  /** Retrieval pipeline tuning */
  retrieval: {
    /** Use multi-signal score fusion vs. pure vector similarity */
    useFusedScoring: boolean;
    /** Boost memories matching current emotional tone */
    emotionalResonance: boolean;
    /** Prevent temporal clustering in results */
    diversitySelection: boolean;
    /** Include entity snapshots in prompt context */
    entityContextInjection: boolean;
    /** Include relationship edges in prompt context */
    relationshipInjection: boolean;
    /** Include arc summaries in prompt context */
    arcInjection: boolean;
    /** Max entities to include in context */
    maxEntitySnapshots: number;
    /** Max relationships to include in context */
    maxRelationships: number;
  };

  /** Memory decay parameters */
  decay: {
    /** Turns (approximately minutes) for memory strength to halve */
    halfLifeTurns: number;
    /** Weight applied to retrieval-based reinforcement */
    reinforcementWeight: number;
    /** Salience threshold above which memories are decay-exempt ("core memories") */
    coreMemoryThreshold: number;
    /** Narrative flags that make a memory decay-exempt regardless of score */
    coreMemoryFlags: string[];
  };

  /** Fact persistence and curation policy */
  factManagement: FactManagementConfig;

  /** Entity lifecycle management */
  entityPruning: {
    /** Auto-archive entities with 1 mention and no recent activity */
    enabled: boolean;
    /** Messages since last mention before auto-archiving a single-mention entity */
    staleAfterMessages: number;
    /** Minimum confidence to persist a new entity (0.0–1.0) */
    minConfidence: number;
  };

  /** Custom proper noun whitelist (fantasy terms that shouldn't be filtered) */
  entityWhitelist: string[];

  /** Additional XML/HTML-style tag names (beyond the curated default set)
   *  whose inner content is structured scaffolding — HUD blocks, status
   *  lines, dice rolls, custom embed wrappers, etc. — and must be removed
   *  wholesale before any cortex evaluator sees the chunk. Lowercase, no
   *  angle brackets, no leading slashes. Example values: "rpgstats",
   *  "encounter", "questlog". */
  nonProseScaffoldTags: string[];

  /** Per-entity-type heuristics controls for header noise and guided extraction */
  entityExtractionFilters: MemoryEntityExtractionFilters;
}

// ─── Defaults ──────────────────────────────────────────────────

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  enabled: false,
  chunkThreshold: 40,
  chunksPerConsolidation: 10,
  arcThreshold: 5,
  useSidecar: false,
  maxTokensPerSummary: 300,
};

export const DEFAULT_CORTEX_CONFIG: MemoryCortexConfig = {
  enabled: false,
  autoWarmup: false,
  presetMode: "simple",
  entityTracking: true,
  entityExtractionMode: "heuristic",
  thoughtMarkers: {
    prefix: "",
    suffix: "",
  },
  salienceScoring: true,
  salienceScoringMode: "heuristic",
  sidecar: {
    connectionProfileId: null,
    model: null,
    temperature: 0.1,
    topP: 1.0,
    maxTokens: 4096,
    chunkBatchSize: 5,
    rebuildConcurrency: 3,
    requestsPerMinute: 0,
  },
  formatterMode: "shadow",
  useChatMemoryFormatting: true,
  contextTokenBudget: 600,
  retrievalTimeoutMs: 60000,
  sidecarTimeoutMs: 60000,
  sidecarReliability: {
    fallback: "heuristic",
    maxRetries: 0,
    retryDelayMs: 500,
    arbitratesHeuristics: false,
    gradesExistingRecords: false,
  },
  consolidation: { ...DEFAULT_CONSOLIDATION_CONFIG },
  retrieval: {
    useFusedScoring: true,
    emotionalResonance: true,
    diversitySelection: true,
    entityContextInjection: true,
    relationshipInjection: false,
    arcInjection: false,
    maxEntitySnapshots: 8,
    maxRelationships: 12,
  },
  decay: {
    halfLifeTurns: 500,
    reinforcementWeight: 0.1,
    coreMemoryThreshold: 0.7,
    coreMemoryFlags: ["death", "promise", "first_meeting", "transformation", "confession"],
  },
  factManagement: {
    importanceThreshold: 3,
    maxFactsPerEntity: 30,
    autopilot: false,
  },
  entityPruning: {
    enabled: true,
    staleAfterMessages: 200,
    minConfidence: 0.4,
  },
  entityWhitelist: [],
  nonProseScaffoldTags: [],
  entityExtractionFilters: getDefaultEntityExtractionFilters(),
};

// ─── Preset Resolvers ──────────────────────────────────────────

/** Apply "simple" preset — minimal knobs, sane defaults */
function applySimplePreset(config: MemoryCortexConfig): MemoryCortexConfig {
  return {
    ...config,
    presetMode: "simple",
    sidecar: { ...config.sidecar, maxTokens: 2048, chunkBatchSize: 3, rebuildConcurrency: 2 },
    entityTracking: true,
    entityExtractionMode: "heuristic",
    salienceScoring: true,
    salienceScoringMode: "heuristic",
    consolidation: { ...DEFAULT_CONSOLIDATION_CONFIG },
    retrieval: {
      useFusedScoring: true,
      emotionalResonance: true,
      diversitySelection: true,
      entityContextInjection: true,
      relationshipInjection: false,
      arcInjection: false,
      maxEntitySnapshots: 8,
      maxRelationships: 12,
    },
  };
}

/** Apply "standard" preset — entities + salience + relationships */
function applyStandardPreset(config: MemoryCortexConfig): MemoryCortexConfig {
  return {
    ...config,
    presetMode: "standard",
    sidecar: { ...config.sidecar, maxTokens: 4096, chunkBatchSize: 5, rebuildConcurrency: 3 },
    entityTracking: true,
    entityExtractionMode: "heuristic",
    salienceScoring: true,
    salienceScoringMode: "heuristic",
    consolidation: { ...DEFAULT_CONSOLIDATION_CONFIG, enabled: true },
    retrieval: {
      useFusedScoring: true,
      emotionalResonance: true,
      diversitySelection: true,
      entityContextInjection: true,
      relationshipInjection: true,
      arcInjection: true,
      maxEntitySnapshots: 10,
      maxRelationships: 16,
    },
  };
}

// ─── Settings Resolution ───────────────────────────────────────

// Per-user cortex config cache. Resolving the config requires a settings-table
// read + normalize on every call; the cortex warmup hot path hits this on
// every chat open. Cache entries are invalidated by every write path
// (putCortexConfig, applyCortexPreset). Values are deep-cloned on read so
// callers can't mutate the cached instance.
const cortexConfigCache = new Map<string, MemoryCortexConfig>();

function invalidateCortexConfigCache(userId: string): void {
  cortexConfigCache.delete(userId);
}

/**
 * Load the cortex configuration for a user.
 * Returns defaults if no config has been saved.
 */
export function getCortexConfig(userId: string): MemoryCortexConfig {
  const cached = cortexConfigCache.get(userId);
  if (cached) return structuredClone(cached);

  const row = settingsSvc.getSetting(userId, SETTINGS_KEY);
  const resolved = !row?.value
    ? { ...DEFAULT_CORTEX_CONFIG }
    : normalizeCortexConfig(row.value as Partial<MemoryCortexConfig>);
  cortexConfigCache.set(userId, structuredClone(resolved));
  return resolved;
}

/**
 * Save cortex configuration. Merges with defaults for missing fields.
 */
export function putCortexConfig(
  userId: string,
  update: Partial<MemoryCortexConfig>,
): MemoryCortexConfig {
  const current = getCortexConfig(userId);
  const merged = normalizeCortexConfig({ ...current, ...update });
  settingsSvc.putSetting(userId, SETTINGS_KEY, merged);
  invalidateCortexConfigCache(userId);
  return merged;
}

/**
 * Apply a preset mode, returning the resulting full config.
 */
export function applyCortexPreset(
  userId: string,
  mode: CortexPresetMode,
): MemoryCortexConfig {
  let config = getCortexConfig(userId);
  config.enabled = true;

  switch (mode) {
    case "simple":
      config = applySimplePreset(config);
      break;
    case "standard":
      config = applyStandardPreset(config);
      break;
    case "advanced":
      config.presetMode = "advanced";
      // Advanced: keep all current settings, just mark mode
      break;
    default:
      config.presetMode = null;
      break;
  }

  settingsSvc.putSetting(userId, SETTINGS_KEY, config);
  invalidateCortexConfigCache(userId);
  return config;
}

/**
 * True when any Cortex feature is configured to call the sidecar LLM.
 * A saved connection profile alone is not enough: users can keep the profile
 * selected while switching individual Cortex features back to heuristics.
 */
export function shouldUseCortexSidecar(config: MemoryCortexConfig): boolean {
  return !!config.sidecar.connectionProfileId && (
    config.entityExtractionMode === "sidecar" ||
    config.salienceScoringMode === "sidecar" ||
    (config.consolidation.enabled && config.consolidation.useSidecar)
  );
}

/** True when per-chunk analysis should call the sidecar extractor. */
export function shouldUseCortexSidecarForChunkAnalysis(config: MemoryCortexConfig): boolean {
  return !!config.sidecar.connectionProfileId && (
    config.entityExtractionMode === "sidecar" ||
    config.salienceScoringMode === "sidecar"
  );
}

/**
 * Normalize a partial config into a full config by merging with defaults.
 */
export function normalizeCortexConfig(
  input: Partial<MemoryCortexConfig>,
): MemoryCortexConfig {
  const defaults = DEFAULT_CORTEX_CONFIG;

  return {
    enabled: input.enabled ?? defaults.enabled,
    autoWarmup: input.autoWarmup ?? defaults.autoWarmup,
    presetMode: input.presetMode ?? defaults.presetMode,
    entityTracking: input.entityTracking ?? defaults.entityTracking,
    entityExtractionMode: input.entityExtractionMode ?? defaults.entityExtractionMode,
    thoughtMarkers: {
      prefix: input.thoughtMarkers?.prefix ?? defaults.thoughtMarkers.prefix,
      suffix: input.thoughtMarkers?.suffix ?? defaults.thoughtMarkers.suffix,
    },
    salienceScoring: input.salienceScoring ?? defaults.salienceScoring,
    salienceScoringMode: input.salienceScoringMode ?? defaults.salienceScoringMode,
    sidecar: {
      connectionProfileId: input.sidecar?.connectionProfileId ?? defaults.sidecar.connectionProfileId,
      model: input.sidecar?.model ?? defaults.sidecar.model,
      temperature: input.sidecar?.temperature ?? defaults.sidecar.temperature,
      topP: input.sidecar?.topP ?? defaults.sidecar.topP,
      maxTokens: input.sidecar?.maxTokens ?? defaults.sidecar.maxTokens,
      chunkBatchSize: input.sidecar?.chunkBatchSize ?? defaults.sidecar.chunkBatchSize,
      rebuildConcurrency: input.sidecar?.rebuildConcurrency ?? defaults.sidecar.rebuildConcurrency,
      requestsPerMinute: normalizeRequestsPerMinute(
        input.sidecar?.requestsPerMinute,
        defaults.sidecar.requestsPerMinute,
      ),
    },
    formatterMode: input.formatterMode ?? defaults.formatterMode,
    useChatMemoryFormatting: typeof input.useChatMemoryFormatting === "boolean"
      ? input.useChatMemoryFormatting
      : defaults.useChatMemoryFormatting,
    contextTokenBudget: input.contextTokenBudget ?? defaults.contextTokenBudget,
    retrievalTimeoutMs: input.retrievalTimeoutMs ?? defaults.retrievalTimeoutMs,
    sidecarTimeoutMs: input.sidecarTimeoutMs ?? defaults.sidecarTimeoutMs,
    sidecarReliability: {
      fallback: input.sidecarReliability?.fallback === "skip" ? "skip" : defaults.sidecarReliability.fallback,
      maxRetries: normalizeNonNegativeInt(
        input.sidecarReliability?.maxRetries,
        defaults.sidecarReliability.maxRetries,
      ),
      retryDelayMs: normalizeNonNegativeInt(
        input.sidecarReliability?.retryDelayMs,
        defaults.sidecarReliability.retryDelayMs,
      ),
      arbitratesHeuristics: input.sidecarReliability?.arbitratesHeuristics
        ?? defaults.sidecarReliability.arbitratesHeuristics,
      gradesExistingRecords: input.sidecarReliability?.gradesExistingRecords
        ?? defaults.sidecarReliability.gradesExistingRecords,
    },
    consolidation: {
      enabled: input.consolidation?.enabled ?? defaults.consolidation.enabled,
      chunkThreshold: input.consolidation?.chunkThreshold ?? defaults.consolidation.chunkThreshold,
      chunksPerConsolidation: input.consolidation?.chunksPerConsolidation ?? defaults.consolidation.chunksPerConsolidation,
      arcThreshold: input.consolidation?.arcThreshold ?? defaults.consolidation.arcThreshold,
      useSidecar: input.consolidation?.useSidecar ?? defaults.consolidation.useSidecar,
      maxTokensPerSummary: input.consolidation?.maxTokensPerSummary ?? defaults.consolidation.maxTokensPerSummary,
    },
    retrieval: {
      useFusedScoring: input.retrieval?.useFusedScoring ?? defaults.retrieval.useFusedScoring,
      emotionalResonance: input.retrieval?.emotionalResonance ?? defaults.retrieval.emotionalResonance,
      diversitySelection: input.retrieval?.diversitySelection ?? defaults.retrieval.diversitySelection,
      entityContextInjection: input.retrieval?.entityContextInjection ?? defaults.retrieval.entityContextInjection,
      relationshipInjection: input.retrieval?.relationshipInjection ?? defaults.retrieval.relationshipInjection,
      arcInjection: input.retrieval?.arcInjection ?? defaults.retrieval.arcInjection,
      maxEntitySnapshots: input.retrieval?.maxEntitySnapshots ?? defaults.retrieval.maxEntitySnapshots,
      maxRelationships: input.retrieval?.maxRelationships ?? defaults.retrieval.maxRelationships,
    },
    decay: {
      halfLifeTurns: input.decay?.halfLifeTurns ?? defaults.decay.halfLifeTurns,
      reinforcementWeight: input.decay?.reinforcementWeight ?? defaults.decay.reinforcementWeight,
      coreMemoryThreshold: input.decay?.coreMemoryThreshold ?? defaults.decay.coreMemoryThreshold,
      coreMemoryFlags: input.decay?.coreMemoryFlags ?? defaults.decay.coreMemoryFlags,
    },
    factManagement: {
      importanceThreshold: Math.max(0, Math.min(10,
        typeof input.factManagement?.importanceThreshold === "number"
          ? Math.floor(input.factManagement.importanceThreshold)
          : defaults.factManagement.importanceThreshold,
      )),
      maxFactsPerEntity: Math.max(5, Math.min(100,
        typeof input.factManagement?.maxFactsPerEntity === "number"
          ? Math.floor(input.factManagement.maxFactsPerEntity)
          : defaults.factManagement.maxFactsPerEntity,
      )),
      autopilot: input.factManagement?.autopilot ?? defaults.factManagement.autopilot,
    },
    entityPruning: {
      enabled: input.entityPruning?.enabled ?? defaults.entityPruning.enabled,
      staleAfterMessages: input.entityPruning?.staleAfterMessages ?? defaults.entityPruning.staleAfterMessages,
      minConfidence: input.entityPruning?.minConfidence ?? defaults.entityPruning.minConfidence,
    },
    entityWhitelist: input.entityWhitelist ?? defaults.entityWhitelist,
    nonProseScaffoldTags: Array.isArray(input.nonProseScaffoldTags)
      ? input.nonProseScaffoldTags
          .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
          .filter((s) => s.length > 0 && /^[a-z0-9_]+$/.test(s))
      : defaults.nonProseScaffoldTags,
    entityExtractionFilters: normalizeEntityExtractionFilters(input.entityExtractionFilters),
  };
}

function normalizeRequestsPerMinute(value: number | null | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeInt(value: number | null | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
