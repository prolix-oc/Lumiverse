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

export interface MemoryCortexConfig {
  /** Master switch — disabling preserves all data but skips cortex retrieval */
  enabled: boolean;

  /** Active preset mode (controls which settings are visible in UI) */
  presetMode: CortexPresetMode;

  /** Build and maintain the entity graph */
  entityTracking: boolean;
  /** Entity extraction strategy */
  entityExtractionMode: "heuristic" | "sidecar" | "off";

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
  };

  /** How cortex data is formatted for LLM injection */
  formatterMode: "shadow" | "attributed" | "clinical" | "minimal";
  /** Max tokens for all cortex-injected content */
  contextTokenBudget: number;

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
  presetMode: "simple",
  entityTracking: true,
  entityExtractionMode: "heuristic",
  salienceScoring: true,
  salienceScoringMode: "heuristic",
  sidecar: {
    connectionProfileId: null,
    model: null,
    temperature: 0.1,
    topP: 1.0,
    maxTokens: 1024,
  },
  formatterMode: "shadow",
  contextTokenBudget: 600,
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
  entityPruning: {
    enabled: true,
    staleAfterMessages: 200,
    minConfidence: 0.4,
  },
  entityWhitelist: [],
};

// ─── Preset Resolvers ──────────────────────────────────────────

/** Apply "simple" preset — minimal knobs, sane defaults */
function applySimplePreset(config: MemoryCortexConfig): MemoryCortexConfig {
  return {
    ...config,
    presetMode: "simple",
    sidecar: { ...config.sidecar, maxTokens: 512 },
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
    sidecar: { ...config.sidecar, maxTokens: 1024 },
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

/**
 * Load the cortex configuration for a user.
 * Returns defaults if no config has been saved.
 */
export function getCortexConfig(userId: string): MemoryCortexConfig {
  const row = settingsSvc.getSetting(userId, SETTINGS_KEY);
  if (!row?.value) return { ...DEFAULT_CORTEX_CONFIG };

  const saved = row.value as Partial<MemoryCortexConfig>;
  return normalizeCortexConfig(saved);
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
  return config;
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
    presetMode: input.presetMode ?? defaults.presetMode,
    entityTracking: input.entityTracking ?? defaults.entityTracking,
    entityExtractionMode: input.entityExtractionMode ?? defaults.entityExtractionMode,
    salienceScoring: input.salienceScoring ?? defaults.salienceScoring,
    salienceScoringMode: input.salienceScoringMode ?? defaults.salienceScoringMode,
    sidecar: {
      connectionProfileId: input.sidecar?.connectionProfileId ?? defaults.sidecar.connectionProfileId,
      model: input.sidecar?.model ?? defaults.sidecar.model,
      temperature: input.sidecar?.temperature ?? defaults.sidecar.temperature,
      topP: input.sidecar?.topP ?? defaults.sidecar.topP,
      maxTokens: input.sidecar?.maxTokens ?? defaults.sidecar.maxTokens,
    },
    formatterMode: input.formatterMode ?? defaults.formatterMode,
    contextTokenBudget: input.contextTokenBudget ?? defaults.contextTokenBudget,
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
    entityPruning: {
      enabled: input.entityPruning?.enabled ?? defaults.entityPruning.enabled,
      staleAfterMessages: input.entityPruning?.staleAfterMessages ?? defaults.entityPruning.staleAfterMessages,
      minConfidence: input.entityPruning?.minConfidence ?? defaults.entityPruning.minConfidence,
    },
    entityWhitelist: input.entityWhitelist ?? defaults.entityWhitelist,
  };
}
