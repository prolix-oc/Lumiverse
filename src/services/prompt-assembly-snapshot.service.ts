import type { AssemblySurfaceV1 } from "../llm/types";

import { createHash } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../db/connection";
import type { Chat } from "../types/chat";
import { isNoPresetChatMetadata, isTemporaryChatMetadata } from "../types/chat";
import type { Message } from "../types/message";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES } from "../types/media-limits";
import type { WorldInfoCache } from "../types/world-book";
import type { PromptBlock, PromptVariableValues } from "../types/preset";
import type { PresetProfileBinding } from "../types/preset-profile";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import type { InputRevisionKindV1, InputRevisionSetV1, PreparationLimitsV1 } from "../types/agent-preprocessing";
import { parseAgentConfigV2 } from "../types/agents";
import {
  CanonicalDataError,
  CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
  cloneCanonicalPlainData,
  encodeCanonicalPlainData,
  freezeCanonicalPlainData,
} from "../utils/canonical-plain-data";
import {
  freezeCognitionGraph,
  normalizeLoomPolicyBucketsV1,
  parseCognitionSourceSnapshot,
} from "./agent-cognition.service";
import { canonicalRuntimeCapabilityDigest } from "./agent-runtime-decision.service";
import {
  applyProfileToBlocks,
  normalizeCategoryBlockStates,
  resolveProfileWithDb,
} from "./preset-profiles.service";
import { collectResolvedPromptVariableValues } from "./prompt-assembly.service";
import { selectNativeVisibleHistory } from "./native-chat-corpus";
import type { AssemblyMediaSegmentV1 as NativeMediaPartProjectionV1 } from "../types/agent-preprocessing";
import { compareUtf8 } from "../utils/utf8-order";
import { worldInfoEntrySourceDigest } from "./world-info-input-revision";
import type {
  CognitionSourceSnapshotV1,
  FrozenCognitionGraphV1,
  LoomPolicyBucketsV1,
} from "../types/agent-cognition";

/**
 * The strict assembly path is deliberately fed by plain data.  It must not
 * retain service instances, database handles, extension registries, callback
 * functions, or mutable model objects across the isolate boundary.
 */
/** Mirrors the canonical value-frame depth: root `0`, each child value `parent + 1`. */
export const SNAPSHOT_DATA_LIMITS_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1;
export const SNAPSHOT_DATA_MAX_DEPTH_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxDepth;
export const SNAPSHOT_DATA_MAX_NODES_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxNodes;

const CORE_TOOL_IDS = [
  "lore_list_books",
  "lore_get_book",
  "lore_list_entries",
  "lore_get_entry",
  "lore_search_entries",
  "chat_search_history",
] as const;

const encoder = new TextEncoder();
const FALLBACK_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  cumulativeExpansionBytes: 16 * 1024 * 1024,
  operationBytes: 2 * 1024 * 1024,
  promptBlocks: 1024,
  activeScripts: 512,
  compiledPatterns: 1024,
  macroResolutions: 10_000,
  trimStrings: 512,
  cooperativeCpuMs: 30_000,
  wallClockMs: 60_000,
  workers: 2,
  queuedJobsPerUser: 4,
  queuedJobsProcess: 32,
});


/** Inputs captured immediately before the strict assembly isolate is entered. */
export interface GenerationAssemblySnapshotInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly generationId?: string;
  /** The caller's authenticated assembly surface; never inferred from policy data. */
  readonly assemblySurface: AssemblySurfaceV1;
  readonly generationType?: "normal" | "continue" | "regenerate" | "swipe";
  readonly connectionId?: string | null;
  readonly presetId?: string | null;
  /** When true with presetId, skip profile resolution exactly as ordinary assemble. */
  readonly forcePresetId?: boolean;
  readonly personaId?: string | null;
  readonly targetCharacterId?: string | null;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  readonly excludeMessageId?: string | null;
  readonly continueMessageId?: string | null;
  readonly userInput?: string;
  /** Live native Databank material resolved before the strict isolate. */
  readonly databank?: SnapshotDatabankV1;
  /** Exact host-resolved structural marker values keyed by active prompt-block ID. */
  readonly structuralBlockValues?: Readonly<Record<string, string>>;
  /** Authenticated media descriptors keyed by admitted current-turn message. */
  readonly mediaPartsByMessageId?: Readonly<Record<string, readonly NativeMediaPartProjectionV1[]>>;
  /** Final native keyword/constant/vector World Info projection. */
  readonly nativeWorldInfo?: SnapshotWorldInfoV1;
  readonly toolIds?: readonly string[];
  /** Authenticated normalized-config revision captured by runtime admission. */
  readonly configRevision?: number | string | null;
  /** Authenticated slot-binding high-water revision captured by admission. */
  readonly bindingRevision?: number | string | null;
  /** Optional authenticated effective connection identity supplied by runtime admission. */
  readonly concreteConnection?: Readonly<Record<string, unknown>>;
  /** Authenticated cognition graph/source supplied by the execution loader. */
  readonly cognitionGraph?: unknown;
  readonly cognitionSource?: unknown;
  /** Authenticated normalized V2 config supplied by runtime admission. */
  readonly agentConfig?: unknown;
  /** Optional authenticated canonical Loom policy buckets. */
  readonly loomPolicy?: unknown;
  readonly limits?: Partial<Record<LegacyLimitKey | keyof PreparationLimitsV1, number>>;
  readonly db?: Database;
  /**
   * Internal escape hatch for callers that already hold the transaction.
   * Normal snapshots remain isolated by their own read transaction.
   */
  readonly useTransaction?: boolean;
}

export interface SnapshotRevisionV1 {
  readonly kind: InputRevisionKindV1;
  /** Compatibility alias for diagnostics grouped by domain. */
  readonly domain: InputRevisionKindV1;
  readonly id: string;
  readonly revision: string;
  readonly digest: string;
}

/**
 * A compatibility-friendly closed revision set. `entries` is the canonical
 * ordered representation; domain arrays are retained to make membership
 * obvious to callers and to prevent accidental omission during future schema
 * additions.
 */
export interface InputRevisionSetV1Local extends InputRevisionSetV1 {
  readonly entries: readonly SnapshotRevisionV1[];
  readonly target: readonly SnapshotRevisionV1[];
  readonly chat: readonly SnapshotRevisionV1[];
  readonly messages: readonly SnapshotRevisionV1[];
  readonly preset: readonly SnapshotRevisionV1[];
  readonly blocks: readonly SnapshotRevisionV1[];
  readonly config: readonly SnapshotRevisionV1[];
  readonly slotBinding: readonly SnapshotRevisionV1[];
  readonly connection: readonly SnapshotRevisionV1[];
  readonly endpoint: readonly SnapshotRevisionV1[];
  readonly credential: readonly SnapshotRevisionV1[];
  readonly participants: readonly SnapshotRevisionV1[];
  readonly worldLore: readonly SnapshotRevisionV1[];
  readonly databank: readonly SnapshotRevisionV1[];
  readonly settings: readonly SnapshotRevisionV1[];
  readonly variables: readonly SnapshotRevisionV1[];
  readonly regex: readonly SnapshotRevisionV1[];
  readonly cognition: readonly SnapshotRevisionV1[];
  readonly readiness: readonly SnapshotRevisionV1[];
}

export interface SnapshotTargetV1 {
  readonly generationType: "normal" | "continue" | "regenerate" | "swipe";
  readonly messageId: string | null;
  readonly swipeId: number | null;
  readonly continueMessageId: string | null;
  readonly excludedMessageId: string | null;
  readonly userInput: string;
}

export interface SnapshotChatV1 extends Omit<Chat, "metadata"> {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly revision: string;
}

export interface SnapshotMessageV1 extends Omit<Message, "extra" | "swipes" | "swipe_dates"> {
  readonly extra: Readonly<Record<string, unknown>>;
  readonly swipes: readonly string[];
  readonly swipe_dates: readonly number[];
  readonly mediaParts?: readonly NativeMediaPartProjectionV1[];
  readonly revision: string;
}

export interface SnapshotBlockV1 extends Omit<PromptBlock, "revision"> {
  readonly order: number;
  readonly revision: string;
}

export interface SnapshotPresetV1 {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly engine: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly prompts: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly blocks: readonly SnapshotBlockV1[];
}

export interface SnapshotParticipantV1 {
  readonly persona: Readonly<Record<string, unknown>> | null;
  readonly character: Readonly<Record<string, unknown>>;
  readonly group: readonly Readonly<Record<string, unknown>>[];
  /** Exact host-resolved structural marker values keyed by active prompt-block ID. */
  readonly structuralBlockValues?: Readonly<Record<string, string>>;
  readonly availabilityRevision: string;
}

export interface SnapshotPromptVariableProjectionV1 {
  readonly values: Readonly<Record<string, string | number>>;
  readonly defaults: Readonly<Record<string, string | number>>;
  readonly byBlock: Readonly<Record<string, Readonly<Record<string, string | number>>>>;
  readonly defaultsByBlock: Readonly<Record<string, Readonly<Record<string, string | number>>>>;
  readonly selections: Readonly<Record<string, readonly string[]>>;
  readonly selectionsByBlock: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export interface SnapshotVariableStateV1 {
  readonly preset: Readonly<PromptVariableValues>;
  /** Resolved profile overlay; null when no binding. Absent only on legacy fixtures. */
  readonly profile?: Readonly<PromptVariableValues> | null;
  /** Coerced effective {{var}} / cognition projection. Absent only on legacy fixtures. */
  readonly effective?: SnapshotPromptVariableProjectionV1;
  readonly chat: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly revision: string;
}

export interface SnapshotRegexScriptV1 {
  readonly id: string;
  readonly name: string;
  readonly findRegex: string;
  readonly replaceString: string;
  readonly actions: readonly unknown[];
  readonly flags: string;
  readonly placement: readonly string[];
  readonly scope: string;
  readonly scopeId: string | null;
  readonly target: readonly string[];
  readonly trimStrings: readonly string[];
  readonly disabled: false;
  readonly sortOrder: number;
  readonly revision: string;
}

export interface SnapshotWorldBookV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "character" | "persona" | "chat" | "global" | "peer";
  readonly order: number;
  readonly revision: string;
}

export interface SnapshotWorldEntryV1 {
  readonly id: string;
  readonly bookId: string;
  readonly bookName: string;
  readonly source: SnapshotWorldBookV1["source"];
  /**
   * This is the complete callback-free activation input. Keep these fields
   * explicit rather than deriving constant/keyword state from `activated`;
   * activation is recomputed in the strict isolate.
   */
  readonly uid: string;
  readonly outletName: string | null;
  readonly wiMarker: string | null;
  readonly wiMarkerSide: "before" | "after" | null;
  readonly order: number;
  readonly orderValue: number;
  readonly activated: boolean;
  readonly disabled: boolean;
  readonly constant: boolean;
  readonly selective: boolean;
  readonly groupName: string;
  readonly groupOverride: boolean;
  readonly groupWeight: number;
  readonly probability: number;
  readonly scanDepth: number | null;
  readonly excludeGreeting: boolean;
  readonly caseSensitive: boolean;
  readonly matchWholeWords: boolean;
  readonly useRegex: boolean;
  readonly preventRecursion: boolean;
  readonly excludeRecursion: boolean;
  readonly delayUntilRecursion: boolean;
  readonly priority: number;
  readonly sticky: number;
  readonly cooldown: number;
  readonly delay: number;
  readonly selectiveLogic: number;
  readonly useProbability: boolean;
  readonly vectorized: boolean;
  readonly vectorIndexStatus: string;
  readonly content: string;
  readonly comment: string;
  readonly keys: readonly string[];
  readonly secondaryKeys: readonly string[];
  readonly position: number;
  readonly depth: number;
  readonly role: string | null;
  readonly state: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly sourceDigest: string;
}

export interface SnapshotNativeWorldInfoRuntimePlacementV1 {
  readonly id: string;
  readonly content: string;
  readonly entryLabel: string;
  readonly orderValue: number;
  readonly placement: Readonly<{ role: "system" | "user" | "assistant"; direction: "from_start" | "from_end"; depth: number }>;
}

export interface SnapshotNativeWorldInfoV1 {
  readonly activatedEntryIds: readonly string[];
  readonly cache: WorldInfoCache;
  readonly runtimePlacements?: readonly SnapshotNativeWorldInfoRuntimePlacementV1[];
  readonly captures?: Readonly<Record<string, readonly unknown[]>>;
  readonly activationOverrides?: Readonly<Record<string, unknown>>;
  readonly sourceFingerprint?: string;
  readonly precomputedVectorAccepted?: boolean;
  readonly vectorViewsEquivalent?: boolean;
  readonly stateAfter: Readonly<Record<string, unknown>>;
  readonly activationEvidence: readonly Readonly<Record<string, unknown>>[];
  readonly vectorDispositions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly stats: Readonly<Record<string, unknown>>;
}

export interface SnapshotWorldInfoV1 {
  readonly books: readonly SnapshotWorldBookV1[];
  readonly entries: readonly SnapshotWorldEntryV1[];
  readonly candidates: readonly SnapshotWorldEntryV1[];
  readonly state: Readonly<Record<string, unknown>>;
  readonly native?: SnapshotNativeWorldInfoV1;
}

export interface SnapshotDatabankChunkV1 {
  readonly chunkId: string;
  readonly documentId: string;
  readonly databankId: string;
  readonly documentName: string;
  readonly content: string;
  readonly score: number | null;
  /** Hash of the source document at retrieval time, when still available. */
  readonly documentContentHash: string | null;
  /** Hash of the exact bounded chunk bytes delivered to WORK. */
  readonly contentHash: string;
}

export interface SnapshotDatabankMentionV1 {
  readonly slug: string;
  readonly documentId: string;
  readonly databankId: string;
  readonly documentName: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly documentContentHash: string | null;
  /** Hash of the exact bounded mention bytes delivered to WORK. */
  readonly contentHash: string;
}

export interface SnapshotDatabankProvenanceV1 {
  readonly kind: "automatic" | "mention";
  readonly databankId: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly chunkId: string | null;
  readonly documentContentHash: string | null;
  /** Hash of the exact bounded native content delivered to WORK. */
  readonly contentHash: string;
}

/**
 * Native Databank is a frozen observational projection. It carries the active
 * scope, bounded retrieval bytes, source hashes, and participating-document
 * revisions; it is never a Loom policy.
 */
export interface SnapshotDatabankV1 {
  readonly enabled: boolean;
  readonly activeBankIds: readonly string[];
  readonly automaticChunks: readonly SnapshotDatabankChunkV1[];
  readonly automaticFormatted: string;
  readonly mentions: readonly SnapshotDatabankMentionV1[];
  /** Current user text after valid native mentions are stripped, before macro resolution. */
  readonly strippedUserInput: string;
  /** Bounded native mention appendix; always appended after macro resolution. */
  readonly mentionAppendix: string;
  readonly provenance: readonly SnapshotDatabankProvenanceV1[];
}

export interface SnapshotAgentCognitionV1 {
  readonly schema: "present";
  /** Canonical versioned Loom buckets sealed to this source snapshot. */
  readonly loomPolicy?: LoomPolicyBucketsV1;
  /** Source-checked cognition graph and Loom source snapshot frozen for this turn. */
  readonly cognitionGraph: FrozenCognitionGraphV1 | null;
  readonly cognitionSource: CognitionSourceSnapshotV1 | null;
  readonly revision: string;
}
export interface SnapshotAvailabilityV1 {
  readonly participantIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly extensionsExcluded: true;
  readonly ambientSpindleExcluded: true;
  readonly revision: string;
}

export interface GenerationAssemblySnapshotV1 {
  readonly version: 1;
  /** Authenticated surface that produced this closed snapshot. */
  readonly assemblySurface: AssemblySurfaceV1;

  readonly snapshotId: string;
  readonly userId: string;
  readonly generationId: string;
  readonly chatId: string;
  readonly target: SnapshotTargetV1;
  readonly chat: SnapshotChatV1;
  readonly messages: readonly SnapshotMessageV1[];
  readonly preset: SnapshotPresetV1 | null;
  readonly blocks: readonly SnapshotBlockV1[];
  readonly participants: SnapshotParticipantV1;
  readonly variables: SnapshotVariableStateV1;
  readonly regexScripts: readonly SnapshotRegexScriptV1[];
  readonly worldInfo: SnapshotWorldInfoV1;
  /** Native Databank observation; absent only on legacy hand-built fixtures. */
  readonly databank?: SnapshotDatabankV1;
  readonly agentCognition: SnapshotAgentCognitionV1;
  readonly availability: SnapshotAvailabilityV1;
  readonly connection: Readonly<Record<string, unknown>> | null;
  /** Normalized V2 config captured by authenticated runtime admission. */
  readonly agentConfig: unknown;
  readonly limits: PreparationLimitsV1;
  readonly inputRevisionSet: InputRevisionSetV1Local;
  /** Alias used by consumers that name the field after its DTO type. */
  readonly revisions: InputRevisionSetV1Local;
  readonly extensionData: null;
  readonly ambientSpindleData: null;
}

type LegacyLimitKey =
  | "inputBytes"
  | "outputBytes"
  | "cumulativeExpansionBytes"
  | "operationBytes"
  | "promptBlocks"
  | "activeScripts"
  | "compiledPatterns"
  | "macroResolutions"
  | "trimStrings"
  | "cooperativeCpuMs"
  | "wallClockMs"
  | "workers"
  | "queuedJobsPerUser"
  | "queuedJobsProcess";
type Limits = PreparationLimitsV1 & Readonly<Record<LegacyLimitKey, number>>;
type RawRow = Record<string, unknown>;

function publicLimits(limits: Limits): PreparationLimitsV1 {
  return Object.freeze({
    maxInputBytes: limits.inputBytes,
    maxOutputBytes: limits.outputBytes,
    maxCumulativeExpansionBytes: limits.cumulativeExpansionBytes,
    maxOperationBytes: limits.operationBytes,
    maxPromptBlocks: limits.promptBlocks,
    maxActiveScripts: limits.activeScripts,
    maxCompiledPatterns: limits.compiledPatterns,
    maxMacroResolutions: limits.macroResolutions,
    maxTrimStrings: limits.trimStrings,
    maxCooperativeCpuMs: limits.cooperativeCpuMs,
    maxWallClockMs: limits.wallClockMs,
    maxWorkers: limits.workers,
    maxQueuedJobsPerUser: limits.queuedJobsPerUser,
    maxQueuedJobsProcess: limits.queuedJobsProcess,
  });
}

function hostLimits(): Limits {
  const source = HOST_PREPARATION_LIMITS_V1;
  const maxInputBytes = source.maxInputBytes;
  const maxOutputBytes = source.maxOutputBytes;
  const maxCumulativeExpansionBytes = source.maxCumulativeExpansionBytes;
  const maxOperationBytes = source.maxOperationBytes;
  const maxPromptBlocks = source.maxPromptBlocks;
  const maxActiveScripts = source.maxActiveScripts;
  const maxCompiledPatterns = source.maxCompiledPatterns;
  const maxMacroResolutions = source.maxMacroResolutions;
  const maxTrimStrings = source.maxTrimStrings;
  const maxCooperativeCpuMs = source.maxCooperativeCpuMs;
  const maxWallClockMs = source.maxWallClockMs;
  const maxWorkers = source.maxWorkers;
  const maxQueuedJobsPerUser = source.maxQueuedJobsPerUser;
  const maxQueuedJobsProcess = source.maxQueuedJobsProcess;
  return Object.freeze({
    ...source,
    inputBytes: maxInputBytes,
    outputBytes: maxOutputBytes,
    cumulativeExpansionBytes: maxCumulativeExpansionBytes,
    operationBytes: maxOperationBytes,
    promptBlocks: maxPromptBlocks,
    activeScripts: maxActiveScripts,
    compiledPatterns: maxCompiledPatterns,
    macroResolutions: maxMacroResolutions,
    trimStrings: maxTrimStrings,
    cooperativeCpuMs: maxCooperativeCpuMs,
    wallClockMs: maxWallClockMs,
    workers: maxWorkers,
    queuedJobsPerUser: maxQueuedJobsPerUser,
    queuedJobsProcess: maxQueuedJobsProcess,
  });
}

function lowerLimits(requested: GenerationAssemblySnapshotInputV1["limits"]): Limits {
  const host = hostLimits();
  const output: Record<string, number> = { ...host };
  const legacyKeys = Object.keys(FALLBACK_LIMITS) as LegacyLimitKey[];
  const canonicalKeys: readonly (keyof PreparationLimitsV1)[] = [
    "maxInputBytes", "maxOutputBytes", "maxCumulativeExpansionBytes", "maxOperationBytes",
    "maxPromptBlocks", "maxActiveScripts", "maxCompiledPatterns", "maxMacroResolutions",
    "maxTrimStrings", "maxCooperativeCpuMs", "maxWallClockMs", "maxWorkers",
    "maxQueuedJobsPerUser", "maxQueuedJobsProcess",
  ];
  for (let index = 0; index < legacyKeys.length; index++) {
    const legacy = legacyKeys[index]!;
    const canonicalKey = canonicalKeys[index]!;
    const requestedValue = requested?.[legacy];
    if (typeof requestedValue === "number" && Number.isFinite(requestedValue) && requestedValue > 0) {
      output[legacy] = Math.min(host[legacy], Math.floor(requestedValue));
      output[canonicalKey] = output[legacy];
    }
  }
  for (const canonicalKey of canonicalKeys) {
    const requestedValue = requested?.[canonicalKey];
    if (typeof requestedValue === "number" && Number.isFinite(requestedValue) && requestedValue > 0) {
      output[canonicalKey] = Math.min(host[canonicalKey], Math.floor(requestedValue));
    }
  }
  for (let index = 0; index < legacyKeys.length; index++) output[legacyKeys[index]!] = output[canonicalKeys[index]!]!;
  return Object.freeze(output) as Limits;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertString(value: unknown, label: string, maxBytes: number, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
  if (utf8Bytes(value) > maxBytes) throw new SnapshotLimitError(`${label} exceeds input limit`);
  return value;
}

function assertId(value: unknown, label: string): string {
  return assertString(value, label, 4096, false);
}

function parseJson<T>(value: unknown, label: string, maxBytes: number, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  assertString(value, label, maxBytes);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new SnapshotInputError(`invalid ${label}`);
  }
}

function objectValue(value: unknown, label: string, maxBytes: number): Readonly<Record<string, unknown>> {
  const parsed = parseJson<unknown>(value, label, maxBytes, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
  try {
    encodeCanonicalPlainData(parsed, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, label);
  }
  return deepFreeze({ ...(parsed as Record<string, unknown>) }, maxBytes);
}

function arrayValue(value: unknown, label: string, maxBytes: number): readonly unknown[] {
  const parsed = parseJson<unknown>(value, label, maxBytes, []);
  if (!Array.isArray(parsed)) throw new SnapshotInputError(`invalid ${label}`);
  try {
    encodeCanonicalPlainData(parsed, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, label);
  }
  return deepFreeze([...parsed], maxBytes);
}

function throwSnapshotDataError(error: unknown, label: string): never {
  if (error instanceof CanonicalDataError && error.code === "limit_exceeded") {
    throw new SnapshotLimitError(`${label} exceeds ${error.dimension ?? "data"} limit`);
  }
  throw new SnapshotInputError(`invalid ${label}`);
}

function deepFreeze<T>(value: T, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): T {
  try {
    return freezeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, "snapshot data");
  }
}

function canonical(value: unknown, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): string {
  try {
    return encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, "snapshot data");
  }
}

function isClosedData(value: unknown, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): boolean {
  try {
    encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
    return true;
  } catch (error) {
    if (error instanceof CanonicalDataError && error.code === "limit_exceeded") return false;
    return false;
  }
}

function normalizeAgentConfig(value: unknown, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): unknown {
  if (value === undefined || value === null) return null;
  try {
    encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    });
  } catch (error) {
    throwSnapshotDataError(error, "agent config");
  }
  try {
    const record = value as Record<string, unknown>;
    if (record.version !== 2) {
      throw new SnapshotInputError("agent config must use canonical V2");
    }
    return deepFreeze(parseAgentConfigV2(value), maxBytes);
  } catch (error) {
    if (error instanceof SnapshotInputError || error instanceof SnapshotLimitError) throw error;
    throw new SnapshotInputError("invalid agent config");
  }
}

function boundedClosedDataBytes(value: unknown, maxBytes: number): number {
  try {
    return utf8Bytes(encodeCanonicalPlainData(value, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes,
    }));
  } catch {
    return maxBytes + 1;
  }
}

function cloneClosedData(value: unknown): unknown {
  try {
    return cloneCanonicalPlainData(value, CANONICAL_SNAPSHOT_DATA_LIMITS_V1);
  } catch (error) {
    throwSnapshotDataError(error, "snapshot data");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function authoredLoomBlockRevision(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1) return String(parsed);
  }
  return "1";
}

function revision(kind: InputRevisionKindV1, id: string, value: unknown, sourceRevision?: unknown): SnapshotRevisionV1 {
  const canonicalValue = canonical(value);
  const valueDigest = createHash("sha256").update(canonicalValue).digest("hex");
  const hasSourceRevision = (
    typeof sourceRevision === "number" && Number.isSafeInteger(sourceRevision)
  ) || (
    typeof sourceRevision === "string" && sourceRevision.length > 0
  );
  return Object.freeze({
    kind,
    domain: kind,
    id,
    revision: hasSourceRevision ? String(sourceRevision) : valueDigest,
    digest: valueDigest,
  });
}

/** Chat fence identity is generation_revision, never chats.updated_at. */
export function liveChatInputRevision(chatId: string, generationRevision: unknown): { revision: string; digest: string } {
  const revisionValue = String(generationRevision ?? "");
  return {
    revision: revisionValue,
    digest: digest({ id: chatId, generationRevision: revisionValue }),
  };
}

/** Message fence identity is generation_revision, never content, swipes, extra, or updated_at. */
export function liveMessageInputRevision(messageId: string, generationRevision: unknown): { revision: string; digest: string } {
  const revisionValue = String(generationRevision ?? "");
  return {
    revision: revisionValue,
    digest: digest({ id: messageId, generationRevision: revisionValue }),
  };
}

/** Databank fence identity covers each native document admitted to the frozen prompt. */
export function liveDatabankDocumentInputRevision(
  documentId: string,
  databankId: unknown,
  documentName: unknown,
  documentContentHash: unknown,
  documentStatus: unknown,
): { revision: string; digest: string } {
  const identity = {
    id: documentId,
    databankId: typeof databankId === "string" ? databankId : "",
    documentName: typeof documentName === "string" ? documentName : "",
    documentContentHash: typeof documentContentHash === "string" && documentContentHash.length > 0
      ? documentContentHash
      : null,
    documentStatus: typeof documentStatus === "string" ? documentStatus : "",
  };
  const valueDigest = digest(identity);
  return { revision: valueDigest, digest: valueDigest };
}

/** Connection fence identity is candidateRevision, never rematerialized capabilities/label/updated_at. */
export function liveConnectionInputRevision(connectionId: string, candidateRevision: unknown): { revision: string; digest: string } {
  const revisionValue = String(candidateRevision ?? "");
  return {
    revision: revisionValue,
    digest: digest({ id: connectionId, candidateRevision: revisionValue }),
  };
}

/** Endpoint fence identity is endpointRevision, never rematerialized provider/model/url. */
export function liveEndpointInputRevision(connectionId: string, endpointRevision: unknown): { revision: string; digest: string } {
  const revisionValue = String(endpointRevision ?? "");
  return {
    revision: revisionValue,
    digest: digest({ id: connectionId, endpointRevision: revisionValue }),
  };
}

/** Credential fence identity is credentialRevision, never connection.updated_at. */
export function liveCredentialInputRevision(connectionId: string, credentialRevision: unknown): { revision: string; digest: string } {
  const revisionValue = String(credentialRevision ?? "");
  return {
    revision: revisionValue,
    digest: digest({ id: connectionId, credentialRevision: revisionValue }),
  };
}

function connectionFenceRevision(
  kind: "connection" | "endpoint" | "credential",
  id: string,
  token: unknown,
): SnapshotRevisionV1 {
  const live = kind === "connection"
    ? liveConnectionInputRevision(id, token)
    : kind === "endpoint"
      ? liveEndpointInputRevision(id, token)
      : liveCredentialInputRevision(id, token);
  return Object.freeze({
    kind,
    domain: kind,
    id,
    revision: live.revision.length > 0 ? live.revision : live.digest,
    digest: live.digest,
  });
}

function generationAuthoritativeSettings(
  settings: Readonly<Record<string, unknown>>,
  presetId: string | null,
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(settings, "globalWorldBooks")) {
    selected.globalWorldBooks = settings.globalWorldBooks;
  }
  if (presetId) {
    const key = `presetRegexEnabled:${presetId}`;
    if (Object.prototype.hasOwnProperty.call(settings, key)) selected[key] = settings[key];
  }
  return selected;
}

/** Settings fence identity is assembly-authoritative keys only, not every settings.updated_at. */
export function liveSettingsInputRevision(
  settings: Readonly<Record<string, unknown>>,
  presetId: string | null,
): { revision: string; digest: string } {
  const identity = generationAuthoritativeSettings(settings, presetId);
  const value = digest(identity);
  return { revision: value, digest: value };
}

export function readLiveSettingsInputRevision(
  db: Database,
  userId: string,
  presetId: string | null,
): { revision: string; digest: string } {
  const keys = ["globalWorldBooks"];
  if (presetId) keys.push(`presetRegexEnabled:${presetId}`);
  const settings: Record<string, unknown> = {};
  for (const key of keys) {
    const row = rowFor<RawRow>(db, "SELECT value FROM settings WHERE user_id = ? AND key = ? LIMIT 1", userId, key);
    if (!row) continue;
    settings[key] = parseJson(row.value, `setting ${key}`, FALLBACK_LIMITS.inputBytes, null);
  }
  return liveSettingsInputRevision(settings, presetId);
}


function rowsFor<T extends RawRow>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function rowFor<T extends RawRow>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | null {
  return (db.query(sql).get(...params) as T | null | undefined) ?? null;
}

function rowNumber(row: RawRow, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rowBoolean(row: RawRow, key: string): boolean {
  return row[key] === true || row[key] === 1 || row[key] === "1";
}

function safeArrayOfStrings(value: unknown, label: string, maxBytes: number): string[] {
  const values = arrayValue(value, label, maxBytes);
  const output: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") throw new SnapshotInputError(`invalid ${label}`);
    assertString(item, label, maxBytes);
    output.push(item);
  }
  return output;
}
function nativeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeDatabank(
  value: unknown,
  fallbackUserInput: string,
  limits: Limits,
): SnapshotDatabankV1 {
  const source = value === undefined || value === null
    ? {}
    : value && typeof value === "object" && !Array.isArray(value)
      ? value as RawRow
      : (() => { throw new SnapshotInputError("invalid Databank projection"); })();
  const maxItems = limits.promptBlocks * 16;
  const text = (raw: unknown, label: string, max = limits.maxOperationBytes): string => {
    if (typeof raw !== "string") throw new SnapshotInputError(`invalid ${label}`);
    return assertString(raw, label, max);
  };
  const nullableText = (raw: unknown, label: string, max = 256): string | null => {
    if (raw === null || raw === undefined) return null;
    return text(raw, label, max);
  };
  const bankIds = Array.isArray(source.activeBankIds)
    ? source.activeBankIds.map((entry, index) => text(entry, `databank.activeBankIds[${index}]`, 256))
    : [];
  if (bankIds.length > maxItems) throw new SnapshotLimitError("Databank bank limit exceeded");
  const automaticChunks: SnapshotDatabankChunkV1[] = [];
  const mentionRows: SnapshotDatabankMentionV1[] = [];
  let nativeBytes = 0;
  const rawChunks = source.automaticChunks === undefined ? [] : arrayValue(source.automaticChunks, "databank.automaticChunks", limits.maxInputBytes);
  if (rawChunks.length > maxItems) throw new SnapshotLimitError("Databank automatic chunk limit exceeded");
  for (const [index, raw] of rawChunks.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SnapshotInputError(`invalid databank chunk ${index}`);
    const row = raw as RawRow;
    const content = text(row.content, `databank.automaticChunks[${index}].content`);
    const chunk: SnapshotDatabankChunkV1 = {
      chunkId: text(row.chunkId, `databank.automaticChunks[${index}].chunkId`, 256),
      documentId: text(row.documentId, `databank.automaticChunks[${index}].documentId`, 256),
      databankId: text(row.databankId, `databank.automaticChunks[${index}].databankId`, 256),
      documentName: text(row.documentName, `databank.automaticChunks[${index}].documentName`, limits.maxOperationBytes),
      content,
      score: row.score === null || row.score === undefined ? null : rowNumber(row, "score", NaN),
      documentContentHash: nullableText(row.documentContentHash, `databank.automaticChunks[${index}].documentContentHash`),
      contentHash: nativeContentHash(content),
    };
    if (chunk.score !== null && !Number.isFinite(chunk.score)) throw new SnapshotInputError(`invalid databank chunk score ${index}`);
    nativeBytes += utf8Bytes(content);
    if (nativeBytes > limits.maxInputBytes) throw new SnapshotLimitError("Databank content limit exceeded");
    automaticChunks.push(chunk);
  }
  const rawMentions = source.mentions === undefined ? [] : arrayValue(source.mentions, "databank.mentions", limits.maxInputBytes);
  if (rawMentions.length > maxItems) throw new SnapshotLimitError("Databank mention limit exceeded");
  for (const [index, raw] of rawMentions.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SnapshotInputError(`invalid databank mention ${index}`);
    const row = raw as RawRow;
    const content = text(row.content, `databank.mentions[${index}].content`);
    const mention: SnapshotDatabankMentionV1 = {
      slug: text(row.slug, `databank.mentions[${index}].slug`, 256),
      documentId: text(row.documentId, `databank.mentions[${index}].documentId`, 256),
      databankId: text(row.databankId, `databank.mentions[${index}].databankId`, 256),
      documentName: text(row.documentName, `databank.mentions[${index}].documentName`, limits.maxOperationBytes),
      content,
      truncated: row.truncated === true,
      documentContentHash: nullableText(row.documentContentHash, `databank.mentions[${index}].documentContentHash`),
      contentHash: nativeContentHash(content),
    };
    nativeBytes += utf8Bytes(content);
    if (nativeBytes > limits.maxInputBytes) throw new SnapshotLimitError("Databank content limit exceeded");
    mentionRows.push(mention);
  }
  const automaticFormatted = source.automaticFormatted === undefined
    ? ""
    : text(source.automaticFormatted, "databank.automaticFormatted", limits.maxInputBytes);
  const strippedUserInput = source.strippedUserInput === undefined
    ? fallbackUserInput
    : text(source.strippedUserInput, "databank.strippedUserInput", limits.maxInputBytes);
  const mentionAppendix = source.mentionAppendix === undefined
    ? ""
    : text(source.mentionAppendix, "databank.mentionAppendix", limits.maxInputBytes);
  nativeBytes += utf8Bytes(automaticFormatted) + utf8Bytes(strippedUserInput) + utf8Bytes(mentionAppendix);
  if (nativeBytes > limits.maxInputBytes) throw new SnapshotLimitError("Databank projection limit exceeded");
  const provenance: SnapshotDatabankProvenanceV1[] = [
    ...automaticChunks.map((chunk) => ({
      kind: "automatic" as const,
      databankId: chunk.databankId,
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      chunkId: chunk.chunkId,
      documentContentHash: chunk.documentContentHash,
      contentHash: chunk.contentHash,
    })),
    ...mentionRows.map((mention) => ({
      kind: "mention" as const,
      databankId: mention.databankId,
      documentId: mention.documentId,
      documentName: mention.documentName,
      chunkId: null,
      documentContentHash: mention.documentContentHash,
      contentHash: mention.contentHash,
    })),
  ];
  return deepFreeze({
    enabled: source.enabled === true,
    activeBankIds: Object.freeze([...new Set(bankIds)]),
    automaticChunks: Object.freeze(automaticChunks),
    automaticFormatted,
    mentions: Object.freeze(mentionRows),
    strippedUserInput,
    mentionAppendix,
    provenance: Object.freeze(provenance),
  }, limits.maxInputBytes);
}


function normalizePromptBlock(raw: unknown, order: number, maxBytes: number): SnapshotBlockV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SnapshotInputError("invalid prompt block");
  const source = raw as Record<string, unknown>;
  const id = assertId(source.id, "prompt block id");
  const content = assertString(source.content ?? "", "prompt block content", maxBytes);
  const role = source.role;
  const position = source.position;
  const validRoles = new Set(["system", "user", "assistant", "user_append", "assistant_append"]);
  const validPositions = new Set(["pre_history", "post_history", "in_history"]);
  if (typeof role !== "string" || !validRoles.has(role)) throw new SnapshotInputError("invalid prompt block role");
  if (typeof position !== "string" || !validPositions.has(position)) throw new SnapshotInputError("invalid prompt block position");
  const variables = source.variables === undefined ? undefined : source.variables;
  const normalized: PromptBlock = {
    id,
    name: assertString(source.name ?? id, "prompt block name", maxBytes),
    content,
    role: role as PromptBlock["role"],
    enabled: source.enabled !== false,
    position: position as PromptBlock["position"],
    depth: typeof source.depth === "number" && Number.isFinite(source.depth) ? Math.max(0, Math.floor(source.depth)) : 0,
    marker: typeof source.marker === "string" ? source.marker : null,
    isLocked: source.isLocked === true,
    color: typeof source.color === "string" ? source.color : null,
    injectionTrigger: Array.isArray(source.injectionTrigger)
      ? source.injectionTrigger.filter((item): item is string => typeof item === "string")
      : [],
    characterTagTrigger: Array.isArray(source.characterTagTrigger)
      ? source.characterTagTrigger.filter((item): item is string => typeof item === "string")
      : undefined,
    group: typeof source.group === "string" ? source.group : null,
    categoryMode: source.categoryMode === "radio" || source.categoryMode === "checkbox" ? source.categoryMode : null,
    variables: Array.isArray(variables) ? variables as PromptBlock["variables"] : undefined,
    placementBinding: source.placementBinding as PromptBlock["placementBinding"],
    stashId: typeof source.stashId === "string" ? source.stashId : undefined,
    sealed: source.sealed === true,
    sealedKey: typeof source.sealedKey === "string" ? source.sealedKey : undefined,
    sealedSource: typeof source.sealedSource === "string" ? source.sealedSource : undefined,
    sealedOriginPresetId: typeof source.sealedOriginPresetId === "string" ? source.sealedOriginPresetId : undefined,
    sealedOriginVersion: typeof source.sealedOriginVersion === "string" ? source.sealedOriginVersion : source.sealedOriginVersion === null ? null : undefined,
    sealedSha256: typeof source.sealedSha256 === "string" ? source.sealedSha256 : undefined,
  };
  return deepFreeze({ ...normalized, order, revision: authoredLoomBlockRevision(source.revision) });
}

function normalizePreset(row: RawRow, limits: Limits): SnapshotPresetV1 {
  const max = limits.inputBytes;
  const id = assertId(row.id, "preset id");
  const parameters = objectValue(row.parameters, "preset parameters", max);
  const prompts = objectValue(row.prompts, "preset prompts", max);
  const metadata = objectValue(row.metadata, "preset metadata", max);
  const promptOrder = parseJson<unknown>(row.prompt_order, "preset prompt order", max, []);
  if (!Array.isArray(promptOrder)) throw new SnapshotInputError("invalid preset prompt order");
  if (promptOrder.length > limits.promptBlocks) throw new SnapshotLimitError("prompt block limit exceeded");
  const blocks = promptOrder.map((block, order) => normalizePromptBlock(block, order, max));
  const value = {
    id,
    name: assertString(row.name ?? id, "preset name", max),
    provider: assertString(row.provider ?? "", "preset provider", max),
    engine: assertString(row.engine ?? "classic", "preset engine", max),
    parameters,
    prompts,
    metadata,
    revision: String(row.cache_revision ?? row.updated_at ?? digest({ id, blocks })),
    blocks,
  } satisfies Omit<SnapshotPresetV1, "revision"> & { revision: string };
  return deepFreeze(value);
}

function normalizeMediaParts(
  parts: readonly NativeMediaPartProjectionV1[] | undefined,
  limits: Limits,
): readonly NativeMediaPartProjectionV1[] {
  if (parts === undefined) return Object.freeze([]);
  if (!Array.isArray(parts) || parts.length > limits.promptBlocks) {
    throw new SnapshotLimitError("message media-part limit exceeded");
  }
  const allowedKeys = new Set(["kind", "mediaType", "mediaId", "mimeType", "byteLength", "sha256"]);
  return Object.freeze(parts.map((part) => {
    if (
      !part
      || typeof part !== "object"
      || Array.isArray(part)
      || Object.keys(part).some((key) => !allowedKeys.has(key))
      || part.kind !== "media"
      || (part.mediaType !== "image" && part.mediaType !== "audio")
      || typeof part.mediaId !== "string"
      || part.mediaId.length === 0
      || utf8Bytes(part.mediaId) > 256
      || typeof part.mimeType !== "string"
      || !/^(?:image|audio)\/[a-z0-9.+-]+$/.test(part.mimeType)
      || (part.mediaType === "image") !== part.mimeType.startsWith("image/")
      || !Number.isSafeInteger(part.byteLength)
      || part.byteLength < 1
      || part.byteLength > (part.mediaType === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)
      || typeof part.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(part.sha256)
    ) {
      throw new SnapshotInputError("message media projection is invalid");
    }
    return deepFreeze({ ...part });
  }));
}

function normalizeMessage(
  row: RawRow,
  limits: Limits,
  mediaParts?: readonly NativeMediaPartProjectionV1[],
): SnapshotMessageV1 {
  const max = limits.inputBytes;
  const swipes = safeArrayOfStrings(row.swipes, "message swipes", max);
  const swipeDatesRaw = arrayValue(row.swipe_dates, "message swipe dates", max);
  const swipeDates = swipeDatesRaw.map((value) => typeof value === "number" && Number.isFinite(value) ? value : 0);
  const extra = objectValue(row.extra, "message extra", max);
  const content = assertString(row.content ?? "", "message content", max);
  const message = {
    id: assertId(row.id, "message id"),
    chat_id: assertId(row.chat_id, "message chat id"),
    index_in_chat: rowNumber(row, "index_in_chat"),
    is_user: rowBoolean(row, "is_user"),
    name: assertString(row.name ?? "", "message name", max),
    content,
    send_date: rowNumber(row, "send_date"),
    swipe_id: Math.max(0, Math.floor(rowNumber(row, "swipe_id"))),
    swipes,
    swipe_dates: swipeDates,
    extra,
    mediaParts: normalizeMediaParts(mediaParts, limits),
    parent_message_id: typeof row.parent_message_id === "string" ? row.parent_message_id : null,
    branch_id: typeof row.branch_id === "string" ? row.branch_id : null,
    created_at: rowNumber(row, "created_at"),
    revision: String(row.revision ?? row.generation_revision ?? row.updated_at ?? digest({ id: row.id, content, swipes, extra })),
  } satisfies SnapshotMessageV1;
  return deepFreeze(message);
}

function normalizeChat(row: RawRow, limits: Limits): SnapshotChatV1 {
  const metadata = objectValue(row.metadata, "chat metadata", limits.inputBytes);
  return deepFreeze({
    id: assertId(row.id, "chat id"),
    character_id: typeof row.character_id === "string" ? row.character_id : null,
    name: assertString(row.name ?? "", "chat name", limits.inputBytes),
    metadata,
    created_at: rowNumber(row, "created_at"),
    updated_at: rowNumber(row, "updated_at"),
    revision: String(row.generation_revision ?? row.revision ?? digest({ id: row.id, metadata })),
  } as SnapshotChatV1);
}


function normalizeStructuralMarkerValues(
  input: Readonly<Record<string, string>> | undefined,
  limits: Limits,
): Readonly<Record<string, string>> {
  if (input === undefined) return Object.freeze({});
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SnapshotInputError("structural block values are invalid");
  }
  const entries = Object.entries(input);
  if (entries.length > limits.promptBlocks) {
    throw new SnapshotLimitError("structural block value count exceeds snapshot limit");
  }
  const output: Record<string, string> = {};
  for (const [blockId, value] of entries) {
    const id = assertId(blockId, "structural block id");
    if (typeof value !== "string") throw new SnapshotInputError("structural block value is invalid");
    output[id] = assertString(value, "structural block value", limits.inputBytes);
  }
  return deepFreeze(output);
}

function normalizeParticipant(row: RawRow | null, limits: Limits): Readonly<Record<string, unknown>> {
  if (!row) return deepFreeze({ id: "__assistant__", name: "Assistant" });
  const allowed = [
    "id", "name", "description", "personality", "scenario", "first_mes", "mes_example",
    "system_prompt", "post_history_instructions", "extensions", "updated_at", "revision",
  ];
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key === "extensions") {
      // Extensions can contain ambient callbacks/registries. Only retain the
      // explicit world-book attachment identifiers needed by this snapshot.
      const extensions = objectValue(row[key], "character extensions", limits.inputBytes);
      output.world_book_ids = safeArrayOfStrings(extensions.world_book_ids ?? [], "character world books", limits.inputBytes);
      continue;
    }
    const value = row[key];
    if (typeof value === "string") output[key] = assertString(value, `participant ${key}`, limits.inputBytes);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) output[key] = value;
  }
  return deepFreeze(output);
}

function normalizePersona(row: RawRow | null, limits: Limits): Readonly<Record<string, unknown>> | null {
  if (!row) return null;
  const output: Record<string, unknown> = {};
  for (const key of [
    "id", "name", "title", "description", "subjective_pronoun", "objective_pronoun",
    "possessive_pronoun", "reflexive_pronoun", "possessive_pronoun_standalone", "attached_world_book_id",
    "is_narrator", "updated_at", "revision",
  ]) {
    const value = row[key];
    if (typeof value === "string") output[key] = assertString(value, `persona ${key}`, limits.inputBytes);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) output[key] = value;
  }
  return deepFreeze(output);
}

function regexFlagsValid(flags: string): boolean {
  const valid = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);
  return [...flags].every((flag) => valid.has(flag)) && new Set(flags).size === flags.length;
}

function regexRowToSnapshot(row: RawRow, limits: Limits): SnapshotRegexScriptV1 | null {
  const pattern = typeof row.find_regex === "string" ? row.find_regex : "";
  const flags = typeof row.flags === "string" ? row.flags : "gi";
  if (!pattern || utf8Bytes(pattern) > limits.operationBytes || !regexFlagsValid(flags)) return null;
  try {
    // A source row with macro placeholders cannot be compiled in the strict
    // worker; it is not an active strict row until a pure snapshot resolver
    // supplies a concrete pattern.
    if (pattern.includes("{{") || pattern.includes("<USER>") || pattern.includes("<BOT>") || pattern.includes("<CHAR>")) return null;
    new RegExp(pattern, flags);
  } catch {
    return null;
  }
  const placements = safeArrayOfStrings(row.placement, "regex placement", limits.operationBytes);
  const targets = safeArrayOfStrings(row.target, "regex target", limits.operationBytes);
  const trimStrings = safeArrayOfStrings(row.trim_strings, "regex trim strings", limits.operationBytes);
  if (trimStrings.length > limits.trimStrings || trimStrings.some((value) => value.length === 0 || utf8Bytes(value) > limits.operationBytes)) return null;
  const actions = arrayValue(row.actions, "regex actions", limits.operationBytes);
  const replaceString = assertString(row.replace_string ?? "", "regex replacement", limits.operationBytes);
  const name = assertString(row.name ?? row.id ?? "", "regex name", limits.operationBytes);
  const script = {
    id: assertId(row.id, "regex id"),
    name,
    findRegex: pattern,
    replaceString,
    actions,
    flags,
    placement: placements,
    scope: typeof row.scope === "string" ? row.scope : "global",
    scopeId: typeof row.scope_id === "string" ? row.scope_id : null,
    target: targets,
    trimStrings,
    disabled: false as const,
    sortOrder: rowNumber(row, "sort_order"),
    revision: String(row.revision ?? row.updated_at ?? digest({ id: row.id, pattern, replaceString, flags, actions })),
  } satisfies SnapshotRegexScriptV1;
  return deepFreeze(script);
}

function parseSettings(rows: RawRow[], limits: Limits): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  let bytes = 0;
  for (const row of rows) {
    const key = assertString(row.key, "setting key", limits.inputBytes, false);
    const raw = typeof row.value === "string" ? row.value : row.value;
    bytes += utf8Bytes(key) + (typeof raw === "string" ? utf8Bytes(raw) : 0);
    if (bytes > limits.inputBytes) throw new SnapshotLimitError("settings input limit exceeded");
    settings[key] = parseJson(raw, `setting ${key}`, limits.inputBytes, null);
  }
  return settings;
}

function getWorldBookIds(
  chat: SnapshotChatV1,
  character: Readonly<Record<string, unknown>>,
  persona: Readonly<Record<string, unknown>> | null,
  group: readonly Readonly<Record<string, unknown>>[],
  settings: Readonly<Record<string, unknown>>,
  maxBooks: number,
): Array<{ id: string; source: SnapshotWorldBookV1["source"] }> {
  const output: Array<{ id: string; source: SnapshotWorldBookV1["source"] }> = [];
  const seen = new Set<string>();
  const push = (value: unknown, source: SnapshotWorldBookV1["source"]) => {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) return;
    if (output.length >= maxBooks) throw new SnapshotLimitError("world-book limit exceeded");
    seen.add(value);
    output.push({ id: value, source });
  };
  const charBooks = character.world_book_ids;
  if (Array.isArray(charBooks)) for (const id of charBooks) push(id, "character");
  for (const member of group) {
    const ids = member.world_book_ids;
    if (Array.isArray(ids)) for (const id of ids) push(id, "character");
  }
  push(persona?.attached_world_book_id, "persona");
  const chatIds = chat.metadata.chat_world_book_ids;
  if (Array.isArray(chatIds)) for (const id of chatIds) push(id, "chat");
  const globals = settings.globalWorldBooks;
  if (Array.isArray(globals)) for (const id of globals) push(id, "global");
  return output;
}

function normalizeNativeWorldInfo(
  input: SnapshotWorldInfoV1,
  limits: Limits,
): SnapshotWorldInfoV1 {
  if (boundedClosedDataBytes(input, limits.inputBytes) > limits.inputBytes) {
    throw new SnapshotLimitError("native World Info projection exceeds the input limit");
  }
  const value = cloneClosedData(input) as SnapshotWorldInfoV1;
  const maxEntries = limits.promptBlocks * 16;
  if (
    !value
    || typeof value !== "object"
    || !Array.isArray(value.books)
    || !Array.isArray(value.entries)
    || !Array.isArray(value.candidates)
    || value.books.length > limits.promptBlocks
    || value.entries.length > maxEntries
    || value.candidates.length > maxEntries
    || !value.native
    || !Array.isArray(value.native.activatedEntryIds)
    || !Array.isArray(value.native.activationEvidence)
  ) {
    throw new SnapshotInputError("native World Info projection is invalid");
  }
  const entryIds = new Set(value.entries.map((entry) => entry.id));
  if (
    value.entries.some((entry) => typeof entry.id !== "string" || typeof entry.revision !== "string" || typeof entry.sourceDigest !== "string")
    || value.books.some((book) => typeof book.id !== "string" || typeof book.revision !== "string")
    || value.native.activatedEntryIds.some((id) => typeof id !== "string" || !entryIds.has(id))
  ) {
    throw new SnapshotInputError("native World Info identity is invalid");
  }
  return deepFreeze(value);
}

function tableColumnSet(db: Database, table: "world_book_entries"): ReadonlySet<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as RawRow[];
  return new Set(rows.map((row) => typeof row.name === "string" ? row.name : "").filter(Boolean));
}

function normalizeWorld(
  db: Database,
  userId: string,
  chat: SnapshotChatV1,
  character: Readonly<Record<string, unknown>>,
  persona: Readonly<Record<string, unknown>> | null,
  group: readonly Readonly<Record<string, unknown>>[],
  settings: Readonly<Record<string, unknown>>,
  limits: Limits,
): SnapshotWorldInfoV1 {
  const requested = getWorldBookIds(chat, character, persona, group, settings, limits.promptBlocks);
  if (requested.length === 0) return deepFreeze({ books: [], entries: [], candidates: [], state: {} });
  if (requested.length > limits.promptBlocks) throw new SnapshotLimitError("world-book limit exceeded");
  const booksById = new Map<string, SnapshotWorldBookV1>();
  const books: SnapshotWorldBookV1[] = [];
  for (let index = 0; index < requested.length; index++) {
    const sourceRef = requested[index]!;
    const row = rowFor<RawRow>(
      db,
      "SELECT id, name, description, updated_at FROM world_books WHERE user_id = ? AND id = ? LIMIT 1",
      userId,
      sourceRef.id,
    );
    if (!row) continue;
    const book = deepFreeze({
      id: assertId(row.id, "world book id"),
      name: assertString(row.name ?? row.id, "world book name", limits.inputBytes),
      description: assertString(row.description ?? "", "world book description", limits.inputBytes),
      source: sourceRef.source,
      order: index,
      revision: String(row.revision ?? row.updated_at ?? digest(row)),
    } satisfies SnapshotWorldBookV1);
    books.push(book);
    booksById.set(book.id, book);
  }
  if (books.length === 0) return deepFreeze({ books: [], entries: [], candidates: [], state: {} });

  const entries: SnapshotWorldEntryV1[] = [];
  const maxEntries = limits.promptBlocks * 16;
  let scannedEntries = 0;
  const entryColumns = tableColumnSet(db, "world_book_entries");
  const selectColumns = [
    "id", "world_book_id", "uid", "key", "keysecondary", "content", "comment", "position", "depth", "role",
    "order_value", "selective", "constant", "disabled", "group_name", "group_override", "group_weight",
    "probability", "scan_depth", "exclude_greeting", "case_sensitive", "match_whole_words", "use_regex",
    "prevent_recursion", "exclude_recursion", "delay_until_recursion", "priority", "sticky", "cooldown", "delay",
    "selective_logic", "use_probability", "vectorized", "vector_index_status", "extensions", "revision",
    "updated_at", "created_at",
  ].filter((column) => entryColumns.has(column));
  const orderColumns = ["order_value", "position", "depth", "created_at", "id"].filter((column) => entryColumns.has(column));
  if (!entryColumns.has("id") || !entryColumns.has("world_book_id") || orderColumns.length === 0) {
    throw new SnapshotInputError("world_book_entries schema is incomplete");
  }
  const entryQuery = `SELECT ${selectColumns.join(", ")} FROM world_book_entries WHERE world_book_id = ? ORDER BY ${orderColumns.join(", ")} LIMIT 1 OFFSET ?`;
  for (const bookId of books.map((book) => book.id).sort(compareUtf8)) {
    let entryOffset = 0;
    while (scannedEntries <= maxEntries) {
      const row = rowFor<RawRow>(db, entryQuery, bookId, entryOffset);
      if (!row) break;
      entryOffset++;
      scannedEntries++;
      if (scannedEntries > maxEntries) throw new SnapshotLimitError("world-entry limit exceeded");
      const book = booksById.get(String(row.world_book_id));
      if (!book) continue;
      const extensions = objectValue(row.extensions ?? "{}", "world entry extensions", limits.inputBytes);
      const rawOutlet = extensions.outlet_name ?? extensions.outletName;
      const rawMarker = extensions.wi_marker ?? extensions.wiMarker;
      const rawMarkerSide = extensions.wi_marker_side ?? extensions.wiMarkerSide;
      const entryValue = {
        id: assertId(row.id, "world entry id"),
        bookId: book.id,
        bookName: book.name,
        source: book.source,
        uid: assertId(row.uid ?? row.id, "world entry uid"),
        outletName: typeof rawOutlet === "string" && rawOutlet.trim().length > 0 ? assertString(rawOutlet.trim(), "world entry outlet", limits.inputBytes) : null,
        wiMarker: typeof rawMarker === "string" && rawMarker.trim().length > 0 ? assertString(rawMarker.trim(), "world entry marker", limits.inputBytes) : null,
        wiMarkerSide: rawMarkerSide === "before" || rawMarkerSide === "after" ? rawMarkerSide : null,
        order: entries.length,
        orderValue: rowNumber(row, "order_value", 100),
        activated: false,
        disabled: rowBoolean(row, "disabled"),
        constant: rowBoolean(row, "constant"),
        selective: rowBoolean(row, "selective"),
        groupName: assertString(row.group_name ?? "", "world entry group", limits.inputBytes),
        groupOverride: rowBoolean(row, "group_override"),
        groupWeight: rowNumber(row, "group_weight", 100),
        probability: rowNumber(row, "probability", 100),
        scanDepth: row.scan_depth === null || row.scan_depth === undefined ? null : rowNumber(row, "scan_depth"),
        excludeGreeting: rowBoolean(row, "exclude_greeting"),
        caseSensitive: rowBoolean(row, "case_sensitive"),
        matchWholeWords: rowBoolean(row, "match_whole_words"),
        useRegex: rowBoolean(row, "use_regex"),
        preventRecursion: rowBoolean(row, "prevent_recursion"),
        excludeRecursion: rowBoolean(row, "exclude_recursion"),
        delayUntilRecursion: rowBoolean(row, "delay_until_recursion"),
        priority: rowNumber(row, "priority", 10),
        sticky: rowNumber(row, "sticky"),
        cooldown: rowNumber(row, "cooldown"),
        delay: rowNumber(row, "delay"),
        selectiveLogic: rowNumber(row, "selective_logic"),
        useProbability: rowBoolean(row, "use_probability"),
        vectorized: rowBoolean(row, "vectorized"),
        vectorIndexStatus: typeof row.vector_index_status === "string" ? row.vector_index_status : "not_enabled",
        content: assertString(row.content ?? "", "world entry content", limits.inputBytes),
        comment: assertString(row.comment ?? "", "world entry comment", limits.inputBytes),
        keys: safeArrayOfStrings(row.key, "world entry keys", limits.inputBytes),
        secondaryKeys: safeArrayOfStrings(row.keysecondary, "world entry secondary keys", limits.inputBytes),
        position: rowNumber(row, "position"),
        depth: rowNumber(row, "depth", 4),
        role: typeof row.role === "string" ? row.role : null,
        state: {},
        revision: String(row.revision ?? row.updated_at ?? digest(row)),
      } satisfies Omit<SnapshotWorldEntryV1, "sourceDigest">;
      const entry = deepFreeze({
        ...entryValue,
        sourceDigest: worldInfoEntrySourceDigest(entryValue),
      } satisfies SnapshotWorldEntryV1);
      entries.push(entry);
    }
  }
  const stateValue = chat.metadata.wi_state;
  const state = stateValue && typeof stateValue === "object" && !Array.isArray(stateValue)
    ? deepFreeze({ ...(stateValue as Record<string, unknown>) })
    : deepFreeze({});
  return deepFreeze({ books, entries, candidates: entries, state });
}

function activeRegexRows(
  db: Database,
  userId: string,
  chat: SnapshotChatV1,
  characterId: string | null,
  presetId: string | null,
  settings: Readonly<Record<string, unknown>>,
  limits: Limits,
): SnapshotRegexScriptV1[] {
  const maxRows = limits.activeScripts * 4;
  let rowOffset = 0;
  const rows: RawRow[] = [];
  while (rowOffset <= maxRows) {
    const row = rowFor<RawRow>(
      db,
      "SELECT * FROM regex_scripts WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT 1 OFFSET ?",
      userId,
      rowOffset,
    );
    if (!row) break;
    rows.push(row);
    rowOffset++;
  }
  if (rows.length > maxRows) throw new SnapshotLimitError("regex row limit exceeded");
  const presetEnabled = presetId ? settings[`presetRegexEnabled:${presetId}`] : undefined;
  const enabledIds = Array.isArray(presetEnabled)
    ? new Set(presetEnabled.filter((value): value is string => typeof value === "string"))
    : null;
  const output: SnapshotRegexScriptV1[] = [];
  for (const row of rows) {
    if (rowBoolean(row, "disabled")) continue;
    const validationErrorCode = typeof row.validation_error_code === "string"
      ? row.validation_error_code.trim()
      : "";
    if (validationErrorCode) {
      throw new SnapshotInputError(`requires_response_mode: active regex script requires repair (${validationErrorCode})`);
    }
    const scope = typeof row.scope === "string" ? row.scope : "global";
    const scopeId = typeof row.scope_id === "string" ? row.scope_id : null;
    if (scope === "character" && scopeId !== characterId) continue;
    if (scope === "chat" && scopeId !== chat.id) continue;
    if (typeof row.preset_id === "string" && presetId !== row.preset_id) continue;
    if (enabledIds && typeof row.preset_id === "string" && !enabledIds.has(String(row.id))) continue;
    const normalized = regexRowToSnapshot(row, limits);
    if (!normalized) continue;
    output.push(normalized);
    if (output.length > limits.activeScripts) throw new SnapshotLimitError("active regex limit exceeded");
  }
  return output;

}
function normalizeTools(toolIds: readonly string[] | undefined, limits: Limits): readonly string[] {
  if (toolIds !== undefined && !Array.isArray(toolIds)) {
    throw new SnapshotInputError("tool IDs must be an array");
  }
  const requested = toolIds === undefined ? CORE_TOOL_IDS : toolIds;
  if (toolIds !== undefined) {
    if (requested.length > limits.promptBlocks) throw new SnapshotLimitError("tool ID limit exceeded");
    let bytes = 0;
    for (const tool of requested) {
      bytes += typeof tool === "string" ? utf8Bytes(tool) : 1;
      if (bytes > limits.inputBytes) throw new SnapshotLimitError("tool input limit exceeded");
    }
  }
  const allowed = new Set<string>(CORE_TOOL_IDS);
  const unique = [...new Set(requested.filter((tool): tool is string => typeof tool === "string" && allowed.has(tool)))];
  return Object.freeze(CORE_TOOL_IDS.filter((tool) => unique.includes(tool)));
}

function getConnection(
  db: Database,
  userId: string,
  connectionId: string | null | undefined,
  presetId: string | null | undefined,
  concrete: Readonly<Record<string, unknown>> | undefined,
  limits: Limits,
): Readonly<Record<string, unknown>> | null {
  const row = concrete
    ? null
    : connectionId
      ? rowFor<RawRow>(db, "SELECT id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, updated_at FROM connection_profiles WHERE id = ? AND user_id = ?", connectionId, userId)
      : rowFor<RawRow>(db, "SELECT id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, updated_at FROM connection_profiles WHERE user_id = ? AND is_default = 1 ORDER BY id LIMIT 1", userId);
  const safe: Record<string, unknown> = {};
  if (concrete) {
    if (Array.isArray(concrete) || !isClosedData(concrete) || boundedClosedDataBytes(concrete, limits.inputBytes) > limits.inputBytes) {
      throw new SnapshotLimitError("connection input limit exceeded");
    }
    const allowed = new Set([
      "logicalId", "concreteId", "label", "provider", "model", "effectiveEndpoint",
      "endpointRevision", "credentialRevision", "candidateRevision", "revision",
      "capabilityDigest", "capabilities",
    ]);
    const hasLogicalIdentity = typeof concrete.logicalId === "string" && concrete.logicalId.trim().length > 0;
    const hasConcreteIdentity = typeof concrete.concreteId === "string" && concrete.concreteId.trim().length > 0;
    if (!hasLogicalIdentity && !hasConcreteIdentity) {
      throw new SnapshotInputError("concrete connection identity is required");
    }
    for (const key of ["candidateRevision", "endpointRevision", "credentialRevision", "capabilityDigest"]) {
      if (!Object.hasOwn(concrete, key)) throw new SnapshotInputError(`missing connection ${key}`);
    }
    const revisionKeys = new Set(["endpointRevision", "credentialRevision", "candidateRevision", "revision"]);
    for (const [key, value] of Object.entries(concrete)) {
      if (!allowed.has(key)) throw new SnapshotInputError(`unsupported connection field: ${key}`);
      if (revisionKeys.has(key) && value !== null) assertRevision(value, `connection ${key}`);
      if (typeof value === "string") safe[key] = assertString(value, `connection ${key}`, limits.inputBytes);
      else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
      else if (isClosedData(value) && boundedClosedDataBytes(value, limits.inputBytes) <= limits.inputBytes) safe[key] = cloneClosedData(value);
      else throw new SnapshotInputError(`invalid connection field: ${key}`);
    }
    const capabilityDigest = safe.capabilityDigest;
    const capabilities = safe.capabilities;
    if (
      typeof capabilityDigest !== "string"
      || !/^[0-9a-f]{64}$/.test(capabilityDigest)
      || capabilities === null
      || typeof capabilities !== "object"
      || Array.isArray(capabilities)
      || canonicalRuntimeCapabilityDigest(
        capabilities as Readonly<Record<string, unknown>>,
      ) !== capabilityDigest
    ) {
      throw new SnapshotInputError("connection capability digest mismatch");
    }
  }
  if (row) {
    for (const key of ["id", "name", "provider", "api_url", "model", "preset_id", "is_default", "has_api_key", "updated_at"]) {
      const value = row[key];
      if (typeof value === "string") safe[key] = assertString(value, `connection ${key}`, limits.inputBytes);
      else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
    }
    safe.metadata = objectValue(row.metadata, "connection metadata", limits.inputBytes);
  }
  if (Object.keys(safe).length === 0 && !presetId && !connectionId) return null;
  return deepFreeze(safe);
}

function ensureAggregateBytes(snapshot: Omit<GenerationAssemblySnapshotV1, "snapshotId" | "inputRevisionSet" | "revisions">, limits: Limits): void {
  const bytes = utf8Bytes(canonical(snapshot));
  if (bytes > limits.inputBytes) throw new SnapshotLimitError("assembly snapshot input limit exceeded");
}

function revisionSet(groups: SnapshotRevisionV1[][]): InputRevisionSetV1Local {
  const entries = Object.freeze(groups.flat());
  const domain = (name: InputRevisionKindV1) => Object.freeze(entries.filter((entry) => entry.domain === name));
  const result = {
    version: 1 as const,
    revisions: entries,
    entries,
    target: domain("target"),
    chat: domain("chat"),
    messages: domain("message"),
    preset: domain("preset"),
    blocks: domain("preset_block"),
    config: domain("config"),
    slotBinding: domain("slot_binding"),
    connection: domain("connection"),
    endpoint: domain("endpoint"),
    credential: domain("credential"),
    participants: domain("persona").concat(domain("character"), domain("group")),
    worldLore: domain("world_lore"),
    databank: domain("databank"),
    settings: domain("settings"),
    variables: domain("macro_variables"),
    regex: domain("regex"),
    cognition: domain("cognition_policy"),
    readiness: domain("readiness"),
    digest: digest(entries),
  } satisfies Omit<InputRevisionSetV1Local, "digest"> & { digest: string };
  return deepFreeze(result);
}

export class SnapshotInputError extends Error {
  readonly code = "invalid_input" as const;
  constructor(message: string) {
    super(message);
    this.name = "SnapshotInputError";
  }
}

export class SnapshotLimitError extends Error {
  readonly code = "limit_exceeded" as const;
  constructor(message: string) {
    super(message);
    this.name = "SnapshotLimitError";
  }
}

const NUMERIC_REVISION_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

function isSafeNonnegativeIntegerLiteral(value: string): boolean {
  const match = value.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|(?:\.(\d+)))(?:e([+-]?\d+))?$/i);
  if (!match || match[1] === "-") return false;
  const integerPart = match[2] ?? "0";
  const fractionPart = match[3] ?? match[4] ?? "";
  const digits = `${integerPart}${fractionPart}`.replace(/^0+/, "");
  if (digits.length === 0) return true;
  const exponent = match[5] ? BigInt(match[5]) : 0n;
  const scale = exponent - BigInt(fractionPart.length);
  if (scale >= 0n) {
    if (scale > 15n) return false;
    const integer = BigInt(`${digits}${"0".repeat(Number(scale))}`);
    return integer <= BigInt(Number.MAX_SAFE_INTEGER);
  }
  const places = -scale;
  if (places > BigInt(digits.length)) return false;
  const placesNumber = Number(places);
  const split = digits.length - placesNumber;
  if (/[^0]/.test(digits.slice(split))) return false;
  const integer = BigInt(digits.slice(0, split) || "0");
  return integer <= BigInt(Number.MAX_SAFE_INTEGER);
}

function assertRevision(value: unknown, label: string): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SnapshotInputError(`invalid ${label}`);
    }
    return;
  }
  if (typeof value !== "string") throw new SnapshotInputError(`invalid ${label}`);
  if (
    value.length === 0
    || value.length > 256
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
  if (NUMERIC_REVISION_PATTERN.test(value) && !isSafeNonnegativeIntegerLiteral(value)) {
    throw new SnapshotInputError(`invalid ${label}`);
  }
}

function assertRequest(input: GenerationAssemblySnapshotInputV1): void {
  if (!input || typeof input !== "object") throw new SnapshotInputError("invalid snapshot input");
  if (input.assemblySurface !== "RESPONSE" && input.assemblySurface !== "WORK") {
    throw new SnapshotInputError("invalid assembly surface");
  }

  assertId(input.userId, "user id");
  assertId(input.chatId, "chat id");
  for (const [value, label] of [
    [input.generationId, "generation id"],
    [input.connectionId, "connection id"],
    [input.presetId, "preset id"],
    [input.personaId, "persona id"],
    [input.targetCharacterId, "target character id"],
    [input.targetMessageId, "target message id"],
    [input.continueMessageId, "continue message id"],
    [input.excludeMessageId, "excluded message id"],
  ] as const) {
    if (value !== undefined && value !== null) assertId(value, label);
  }
  for (const [value, label] of [
    [input.configRevision, "config revision"],
    [input.bindingRevision, "binding revision"],
  ] as const) {
    if (value !== undefined && value !== null) assertRevision(value, label);
  }
  if (input.generationType && !["normal", "continue", "regenerate", "swipe"].includes(input.generationType)) {
    throw new SnapshotInputError("unsupported generation type");
  }
  if (input.targetSwipeId !== undefined && input.targetSwipeId !== null && (!Number.isSafeInteger(input.targetSwipeId) || input.targetSwipeId < 0)) {
    throw new SnapshotInputError("invalid target swipe");
  }
}

function freezeExplicitCognition(
  input: GenerationAssemblySnapshotInputV1,
): { readonly graph: FrozenCognitionGraphV1; readonly source: CognitionSourceSnapshotV1 } | null {
  const graphValue = input.cognitionGraph;
  const sourceValue = input.cognitionSource;
  if (graphValue === undefined && sourceValue === undefined) return null;
  if (graphValue === undefined || sourceValue === undefined) {
    throw new SnapshotInputError("cognition graph and source must be supplied together");
  }
  try {
    const source = parseCognitionSourceSnapshot(sourceValue);
    if (!graphValue || typeof graphValue !== "object" || Array.isArray(graphValue)) {
      throw new SnapshotInputError("invalid cognition graph");
    }
    const graph = graphValue as Record<string, unknown>;
    const baseGraph = {
      version: graph.version,
      policies: graph.policies,
      templates: graph.templates,
    };
    const frozen = freezeCognitionGraph(baseGraph, source);
    if (canonical(frozen) !== canonical(graphValue)) {
      throw new SnapshotInputError("cognition graph source revision mismatch");
    }
    return {
      graph: deepFreeze(frozen),
      source: deepFreeze(source),
    };
  } catch (error) {
    if (error instanceof SnapshotInputError) throw error;
    throw new SnapshotInputError("invalid cognition graph/source");
  }
}
const EMPTY_LOOM_POLICY_BUCKETS: LoomPolicyBucketsV1 = Object.freeze({
  version: 1,
  workPolicy: Object.freeze([]),
  workspaceUsage: Object.freeze([]),
  completionCriteria: Object.freeze([]),
  renderPolicy: Object.freeze([]),
});

function resolveLoomPolicyBuckets(
  input: GenerationAssemblySnapshotInputV1,
  cognition: { readonly graph: FrozenCognitionGraphV1; readonly source: CognitionSourceSnapshotV1 } | null,
  normalizedAgentConfig: unknown,
): LoomPolicyBucketsV1 {
  if (!cognition) {
    if (input.loomPolicy !== undefined) {
      throw new SnapshotInputError("Loom policy buckets require a cognition source");
    }
    return EMPTY_LOOM_POLICY_BUCKETS;
  }
  const config = normalizedAgentConfig && typeof normalizedAgentConfig === "object" && !Array.isArray(normalizedAgentConfig)
    ? normalizedAgentConfig as Record<string, unknown>
    : {};
  const value = input.loomPolicy !== undefined
    ? input.loomPolicy
    : (config.runtimePolicy as Record<string, unknown> | undefined)?.loomPolicy;
  try {
    return normalizeLoomPolicyBucketsV1(value, cognition.source);
  } catch {
    throw new SnapshotInputError("invalid Loom policy buckets");
  }
}

function freezePromptVariableValues(value: unknown): PromptVariableValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return deepFreeze({});
  return deepFreeze({ ...(value as PromptVariableValues) });
}

function withEffectiveProfileBlocks(
  blocks: readonly SnapshotBlockV1[],
  binding: PresetProfileBinding | null,
): readonly SnapshotBlockV1[] {
  const next = blocks.map((block) => ({ ...block }));
  if (binding) applyProfileToBlocks(next as PromptBlock[], binding);
  normalizeCategoryBlockStates(next as PromptBlock[]);
  return Object.freeze(next.map((block) => deepFreeze(block)));
}

function buildAgentCognition(
  input: GenerationAssemblySnapshotInputV1,
  normalizedAgentConfig: unknown,
): SnapshotAgentCognitionV1 {
  const cognition = freezeExplicitCognition(input);
  const loomPolicy = resolveLoomPolicyBuckets(input, cognition, normalizedAgentConfig);
  const cognitionGraph = cognition?.graph ?? null;
  const cognitionSource = cognition?.source ?? null;
  return deepFreeze({
    schema: "present" as const,
    loomPolicy,
    cognitionGraph,
    cognitionSource,
    revision: digest({ loomPolicy, cognitionGraph, cognitionSource }),
  });
}


/**
 * Read all inputs under one SQLite read transaction. No extension/Spindle
 * callbacks or live service instances cross this boundary, which keeps the
 * revision set meaningful.
 */
export function buildGenerationAssemblySnapshot(
  input: GenerationAssemblySnapshotInputV1,
): GenerationAssemblySnapshotV1 {
  assertRequest(input);
  const limits = lowerLimits(input.limits);
  const db = input.db ?? getDb();
  const readSnapshot = () => {
  const chatRow = rowFor<RawRow>(db, "SELECT id, character_id, name, metadata, created_at, updated_at, generation_revision FROM chats WHERE id = ? AND user_id = ? LIMIT 1", input.chatId, input.userId);
  if (!chatRow) throw new SnapshotInputError("chat not found");
  const chat = normalizeChat(chatRow, limits);
    const maxMessages = limits.promptBlocks * 16;
    const messagePageSize = 1;
    const storedMessages: SnapshotMessageV1[] = [];
    let messageOffset = 0;
    while (messageOffset <= maxMessages) {
      const page = rowsFor<RawRow>(
        db,
        "SELECT id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, parent_message_id, branch_id, created_at, generation_revision FROM messages WHERE chat_id = ? ORDER BY index_in_chat ASC, id ASC LIMIT ? OFFSET ?",
        chat.id,
        messagePageSize,
        messageOffset,
      );
      if (page.length === 0) break;
      if (storedMessages.length + page.length > maxMessages) throw new SnapshotLimitError("message count limit exceeded");
      for (const row of page) {
        const rowId = typeof row.id === "string" ? row.id : "";
        storedMessages.push(normalizeMessage(row, limits, input.mediaPartsByMessageId?.[rowId]));
      }
      messageOffset += page.length;
      if (page.length < messagePageSize) break;
    }
    const storedMessageIds = new Set(storedMessages.map((message) => message.id));
    for (const messageId of Object.keys(input.mediaPartsByMessageId ?? {})) {
      if (!storedMessageIds.has(messageId)) throw new SnapshotInputError("media projection references an unavailable message");
    }
    const messages = selectNativeVisibleHistory(chat, storedMessages);
    if (utf8Bytes(canonical(messages)) > limits.inputBytes) {
      throw new SnapshotLimitError("message input limit exceeded");
    }
    const metadata = chat.metadata;
    const selectedPresetId = input.presetId ?? (typeof input.connectionId === "string" ? null : null);
    const connection = getConnection(db, input.userId, input.connectionId, selectedPresetId, input.concreteConnection, limits);
    let effectivePresetId = selectedPresetId ?? (typeof connection?.preset_id === "string" ? connection.preset_id : null);
    const presetRow = effectivePresetId
      ? rowFor<RawRow>(db, "SELECT id, name, provider, engine, parameters, prompt_order, metadata, prompts, updated_at, cache_revision FROM presets WHERE id = ? AND user_id = ? LIMIT 1", effectivePresetId, input.userId)
      : null;
    if (effectivePresetId && !presetRow) throw new SnapshotInputError("preset not found");
    let preset = presetRow ? normalizePreset(presetRow, limits) : null;
    let blocks = preset?.blocks ?? [];
    const characterId = input.targetCharacterId ?? chat.character_id;
    const characterRow = characterId
      ? rowFor<RawRow>(db, "SELECT id, name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, extensions, updated_at FROM characters WHERE id = ? AND user_id = ? LIMIT 1", characterId, input.userId)
      : null;
    const character = characterRow ? normalizeParticipant(characterRow, limits) : normalizeParticipant(null, limits);
    const rawGroupIds = metadata.group === true || metadata.group === 1
      ? Array.isArray(metadata.character_ids) ? metadata.character_ids.filter((id): id is string => typeof id === "string") : []
      : [];
    const groupIds = [...new Set(rawGroupIds)];
    if (groupIds.length > limits.promptBlocks) throw new SnapshotLimitError("group participant limit exceeded");
    const group: Readonly<Record<string, unknown>>[] = [];
    if (groupIds.length > 0) {
      for (const id of groupIds) {
        const row = rowFor<RawRow>(
          db,
          "SELECT id, name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, extensions, updated_at FROM characters WHERE user_id = ? AND id = ? LIMIT 1",
          input.userId,
          id,
        );
        if (row) group.push(normalizeParticipant(row, limits));
      }
    }
    const isTemporaryChat = isTemporaryChatMetadata(metadata);
    const forcePresetId = input.forcePresetId === true && typeof input.presetId === "string" && input.presetId.length > 0;
    const skipProfileBinding = forcePresetId || isNoPresetChatMetadata(metadata);
    const personaId = isTemporaryChat
      ? null
      : input.personaId ?? (typeof metadata.persona_id === "string" ? metadata.persona_id : null);
    const personaRow = isTemporaryChat
      ? null
      : personaId
        ? rowFor<RawRow>(db, "SELECT id, name, title, description, subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone, attached_world_book_id, is_narrator, updated_at FROM personas WHERE id = ? AND user_id = ? LIMIT 1", personaId, input.userId)
        : rowFor<RawRow>(db, "SELECT id, name, title, description, subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone, attached_world_book_id, is_narrator, updated_at FROM personas WHERE user_id = ? AND is_default = 1 ORDER BY id LIMIT 1", input.userId);
    const persona = normalizePersona(personaRow, limits);
    const resolvedProfile = skipProfileBinding
      ? {
          preset_id: forcePresetId ? input.presetId ?? null : effectivePresetId,
          binding: null,
          source: "none" as const,
          source_id: null,
        }
      : resolveProfileWithDb(
          db,
          input.userId,
          effectivePresetId,
          chat.id,
          typeof characterId === "string" ? characterId : null,
          {
            isGroup: metadata.group === true,
            connectionId: typeof connection?.id === "string"
              ? connection.id
              : typeof connection?.logicalId === "string"
                ? connection.logicalId
                : input.connectionId ?? null,
            personaId: isTemporaryChat
              ? null
              : typeof persona?.id === "string" ? persona.id : input.personaId ?? null,
          },
        );
    const profileBinding = resolvedProfile.binding;
    if (!skipProfileBinding && resolvedProfile.preset_id && resolvedProfile.preset_id !== effectivePresetId) {
      const boundRow = rowFor<RawRow>(db, "SELECT id, name, provider, engine, parameters, prompt_order, metadata, prompts, updated_at, cache_revision FROM presets WHERE id = ? AND user_id = ? LIMIT 1", resolvedProfile.preset_id, input.userId);
      if (!boundRow) throw new SnapshotInputError("preset not found");
      preset = normalizePreset(boundRow, limits);
      effectivePresetId = resolvedProfile.preset_id;
    }
    blocks = withEffectiveProfileBlocks(preset?.blocks ?? [], profileBinding);
    const settingsValues: Record<string, unknown> = {};
    let settingsOffset = 0;
    let settingsBytes = 0;
    while (settingsOffset <= limits.promptBlocks * 16) {
      const page = rowsFor<RawRow>(
        db,
        "SELECT key, value, updated_at FROM settings WHERE user_id = ? ORDER BY key ASC LIMIT 1 OFFSET ?",
        input.userId,
        settingsOffset,
      );
      if (page.length === 0) break;
      if (settingsOffset + page.length > limits.promptBlocks * 16) {
        throw new SnapshotLimitError("settings row limit exceeded");
      }
      const parsed = parseSettings(page, limits);
      settingsBytes += utf8Bytes(canonical(parsed));
      if (settingsBytes > limits.inputBytes) throw new SnapshotLimitError("settings input limit exceeded");
      Object.assign(settingsValues, parsed);
      settingsOffset += page.length;
    }
    const settings = deepFreeze(settingsValues);
    const settingsIdentity = generationAuthoritativeSettings(settings, effectivePresetId);
    const chatVariables = metadata.chat_variables && typeof metadata.chat_variables === "object" && !Array.isArray(metadata.chat_variables)
      ? deepFreeze({ ...(metadata.chat_variables as Record<string, unknown>) })
      : deepFreeze({});
    const presetVariables = freezePromptVariableValues(preset?.metadata.promptVariables);
    const profileVariables = profileBinding
      ? freezePromptVariableValues(profileBinding.prompt_variables ?? {})
      : null;
    const collected = collectResolvedPromptVariableValues(
      blocks,
      presetVariables,
      profileBinding ? profileBinding.prompt_variables ?? {} : undefined,
    );
    const effective = deepFreeze({
      values: collected.values,
      defaults: collected.defaults,
      byBlock: collected.byBlock,
      defaultsByBlock: collected.defaultsByBlock,
      selections: collected.selections,
      selectionsByBlock: collected.selectionsByBlock,
    } satisfies SnapshotPromptVariableProjectionV1);
    const variableIdentity = {
      preset: presetVariables,
      profile: profileVariables,
      effective,
      binding: {
        source: resolvedProfile.source,
        sourceId: resolvedProfile.source_id,
        presetId: resolvedProfile.preset_id,
        blockStates: profileBinding?.block_states ?? null,
        linkedToDefaults: profileBinding?.linked_to_defaults === true,
        skipProfileBinding,
        forcePresetId,
        temporaryChat: isTemporaryChat,
      },
      blockEnabled: Object.fromEntries(blocks.map((block) => [block.id, block.enabled])),
      chat: chatVariables,
      settings: settingsIdentity,
    };
    const variables = deepFreeze({
      preset: presetVariables,
      profile: profileVariables,
      effective,
      chat: chatVariables,
      settings,
      revision: digest(variableIdentity),
    } satisfies SnapshotVariableStateV1);
    const regexScripts = activeRegexRows(db, input.userId, chat, characterId, effectivePresetId, settings, limits);
    const worldInfo = input.nativeWorldInfo
      ? normalizeNativeWorldInfo(input.nativeWorldInfo, limits)
      : normalizeWorld(db, input.userId, chat, character, persona, group, settings, limits);
    const targetMessageId = input.targetMessageId ?? input.continueMessageId ?? null;
    const target = deepFreeze({
      generationType: input.generationType ?? "normal",
      messageId: targetMessageId,
      swipeId: input.targetSwipeId ?? null,
      continueMessageId: input.continueMessageId ?? null,
      excludedMessageId: input.excludeMessageId ?? null,
      userInput: assertString(input.userInput ?? "", "user input", limits.inputBytes),
    } satisfies SnapshotTargetV1);
    const databank = normalizeDatabank(input.databank, target.userInput, limits);
    const participantIds = [
      persona?.id,
      character.id,
      ...group.map((member) => typeof member.id === "string" ? member.id : null),
    ].filter((id): id is string => typeof id === "string");
    const tools = normalizeTools(input.toolIds, limits);
    const availability = deepFreeze({
      participantIds: Object.freeze([...participantIds]),
      toolIds: tools,
      extensionsExcluded: true as const,
      ambientSpindleExcluded: true as const,
      revision: digest({ participantIds, tools }),
    } satisfies SnapshotAvailabilityV1);
    const normalizedAgentConfig = normalizeAgentConfig(input.agentConfig, limits.inputBytes);
    const agentCognition = buildAgentCognition(
      normalizedAgentConfig === input.agentConfig ? input : { ...input, agentConfig: normalizedAgentConfig },
      normalizedAgentConfig,
    );
    const targetRevision = revision("target", `${chat.id}:${target.messageId ?? "none"}:${target.swipeId ?? "none"}`, {
      generationType: target.generationType,
      messageId: target.messageId,
      swipeId: target.swipeId,
      continueMessageId: target.continueMessageId,
      excludedMessageId: target.excludedMessageId,
    });
    const chatRevision = revision("chat", chat.id, { id: chat.id, generationRevision: chat.revision }, chat.revision);
    const messageRevisions = messages.map((message) => revision("message", message.id, { id: message.id, generationRevision: message.revision }, message.revision));
    const presetRevision = preset ? [revision("preset", preset.id, preset, preset.revision)] : [];
    const blockRevisions = blocks.map((block) => revision("preset_block", block.id, block, block.revision));
    const concreteConnectionId = String(connection?.concreteId ?? connection?.logicalId ?? connection?.id ?? "default");
    const revisionPresetId = effectivePresetId ?? "none";
    const configRevision = [revision("config", revisionPresetId, normalizedAgentConfig ?? {}, input.configRevision)];
    const slotBindingValue = {
      logicalId: connection?.logicalId ?? connection?.id ?? null,
      concreteId: connection?.concreteId ?? connection?.id ?? null,
      bindingRevision: input.bindingRevision ?? null,
    };
    const slotBindingRevision = [revision("slot_binding", revisionPresetId, slotBindingValue, input.bindingRevision)];
    const candidateSourceRevision = Object.hasOwn(connection ?? {}, "candidateRevision")
      ? connection?.candidateRevision
      : connection?.revision ?? connection?.updated_at;
    const connectionRevision = connection
      ? [connectionFenceRevision("connection", concreteConnectionId, candidateSourceRevision)]
      : [];
    const endpointRevision = connection
      ? [connectionFenceRevision("endpoint", concreteConnectionId, connection.endpointRevision)]
      : [];
    const credentialRevision = connection
      ? [connectionFenceRevision("credential", concreteConnectionId, connection.credentialRevision)]
      : [];
    const participantRevisions = [
      persona ? revision("persona", String(persona.id), persona, persona.revision) : null,
      revision("character", String(character.id), character, character.revision),
      ...group.map((member) => revision("group", String(member.id), member, member.revision)),
    ].filter((item): item is SnapshotRevisionV1 => !!item);
    const worldMembershipDigest = digest({
      books: worldInfo.books.map((book) => book.id).sort(compareUtf8),
      entries: worldInfo.entries.map((entry) => entry.id).sort(compareUtf8),
    });
    const worldRevisions = [
      ...worldInfo.books.map((book) => revision("world_lore", book.id, {
        id: book.id,
        name: book.name,
        description: book.description,
        membershipDigest: worldMembershipDigest,
      }, book.revision)),
      ...worldInfo.entries.map((entry) => revision("world_lore", entry.id, {
        sourceDigest: entry.sourceDigest,
        membershipDigest: worldMembershipDigest,
      }, entry.revision)),
      revision("world_lore", chat.id, {
        state: worldInfo.state,
        membershipDigest: worldMembershipDigest,
      }, digest(worldInfo.state)),
    ];
    const databankRevisions: SnapshotRevisionV1[] = [];
    const seenDatabankDocuments = new Set<string>();
    for (const source of databank.provenance) {
      if (seenDatabankDocuments.has(source.documentId)) continue;
      seenDatabankDocuments.add(source.documentId);
      const live = liveDatabankDocumentInputRevision(
        source.documentId,
        source.databankId,
        source.documentName,
        source.documentContentHash,
        "ready",
      );
      databankRevisions.push(Object.freeze({
        kind: "databank",
        domain: "databank",
        id: source.documentId,
        revision: live.revision,
        digest: live.digest,
      }));
    }
    const settingsRevision = [revision("settings", input.userId, settingsIdentity, digest(settingsIdentity))];
    const variableRevision = [revision("macro_variables", `${chat.id}:${preset?.id ?? "none"}`, variableIdentity, variables.revision)];
    const regexRevisions = regexScripts.map((script) => revision("regex", script.id, script, script.revision));
    const cognitionRevisionValue = { agentConfig: normalizedAgentConfig ?? {}, agentCognition };
    const cognitionRevision = [revision("cognition_policy", preset?.id ?? "none", cognitionRevisionValue, digest(cognitionRevisionValue))];
    const readinessRevision = [revision("readiness", `${input.userId}:${chat.id}`, availability, availability.revision)];
    const runtimeEpochRevision = [revision("runtime_epoch", `${input.userId}:${chat.id}`, { generationId: input.generationId ?? "", snapshotVersion: 1 }, digest({ generationId: input.generationId ?? "", snapshotVersion: 1 }))];
    const revisions = revisionSet([
      [targetRevision, chatRevision],
      messageRevisions,
      presetRevision,
      blockRevisions,
      configRevision,
      slotBindingRevision,
      connectionRevision,
      endpointRevision,
      credentialRevision,
      participantRevisions,
      worldRevisions,
      databankRevisions,
      settingsRevision,
      variableRevision,
      regexRevisions,
      cognitionRevision,
      readinessRevision,
      runtimeEpochRevision,
    ]);
    const base = {
      version: 1 as const,
      assemblySurface: input.assemblySurface,
      userId: input.userId,
      generationId: input.generationId ?? `${chat.id}:${target.messageId ?? "new"}:${target.swipeId ?? "active"}`,
      chatId: chat.id,
      target,
      chat,
      messages,
      preset,
      blocks,
      participants: deepFreeze({
        persona,
        character,
        group: Object.freeze(group),
        structuralBlockValues: normalizeStructuralMarkerValues(input.structuralBlockValues, limits),
        availabilityRevision: availability.revision,
      } satisfies SnapshotParticipantV1),
      variables,
      regexScripts: Object.freeze(regexScripts),
      worldInfo,
      databank,
      agentCognition,
      availability,
      connection,
      agentConfig: normalizedAgentConfig,
      limits: publicLimits(limits),
      extensionData: null,
      ambientSpindleData: null,
    } satisfies Omit<GenerationAssemblySnapshotV1, "snapshotId" | "inputRevisionSet" | "revisions">;
    ensureAggregateBytes(base, limits);
    const snapshotId = digest({ base, revisions });
    return deepFreeze({ ...base, snapshotId, inputRevisionSet: revisions, revisions });
  };
  return input.useTransaction === false ? readSnapshot() : db.transaction(readSnapshot)();
}

export function isGenerationAssemblySnapshotV1(value: unknown): value is GenerationAssemblySnapshotV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GenerationAssemblySnapshotV1>;
  return candidate.version === 1
    && typeof candidate.snapshotId === "string"
    && typeof candidate.userId === "string"
    && (candidate.assemblySurface === "RESPONSE" || candidate.assemblySurface === "WORK")
    && typeof candidate.chatId === "string"
    && candidate.agentCognition?.schema === "present"
    && candidate.agentCognition.cognitionGraph !== undefined
    && candidate.agentCognition.cognitionSource !== undefined
    && candidate.availability?.extensionsExcluded === true
    && candidate.availability?.ambientSpindleExcluded === true
    && candidate.extensionData === null
    && candidate.ambientSpindleData === null;
}
