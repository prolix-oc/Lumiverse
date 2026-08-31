import { createHash } from "node:crypto";
import type { AssemblySurfaceV1 } from "../llm/types";
import { STRUCTURAL_PROMPT_MARKERS } from "../types/preset";
import { projectActivationProvenance } from "../spindle/activation-provenance";
import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_NATIVE_MESSAGE_MEDIA_PARTS,
  MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../types/media-limits";
import { AGENT_CHILD_TASK_MAX_BYTES } from "./agent-runtime-accounting";

import { preflightAgentIntrinsics, AgentIntrinsicValidationError } from "./agent-intrinsics.service";
import { registry as macroRegistry } from "../macros/MacroRegistry";
import {
  activateSnapshotWorldInfo,
  agentMarkersPresent,
  applySnapshotPromptRegex,
  buildSnapshotMacroEnv,
  createSnapshotExpansionBudget,
  resolveSnapshotMacroText,
  setSnapshotBlockMacroContext,
  type SnapshotWorldPreparationV1,
} from "./agentic-assembly-preprocessing";
import type { PreparationDeltaV1, SourceMessageDeltaV1 } from "../types/agent-preprocessing";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import {
  CanonicalDataError,
  encodeCanonicalPlainData,
  validateCanonicalPlainData,
} from "../utils/canonical-plain-data";
export {
  CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
  SNAPSHOT_DATA_MAX_DEPTH_V1,
  SNAPSHOT_DATA_MAX_NODES_V1,
} from "../utils/canonical-plain-data";
import {
  parseAgentConfigV2,
  type AgentConfigV2,
  type AgentCustomPhaseV1,
} from "../types/agents";
import {
  compileAgentRuntimePhases,
  type AgentRuntimePhaseCompileResultV1,
} from "./agentic-phase-runtime.service";
import type {
  AssemblyActivationEvidenceV1,
  AssemblyChildDescriptorV1 as SharedAssemblyChildDescriptorV1,
  AssemblyCompiledPolicyMessageProvenanceV1 as SharedAssemblyCompiledPolicyMessageProvenanceV1,
  AssemblyCompiledPolicyProviderMessageV1 as SharedAssemblyCompiledPolicyProviderMessageV1,
  AssemblyDatabankMessageProvenanceV1,
  AssemblyLiteralSegmentV1 as SharedAssemblyLiteralSegmentV1,
  AssemblyLoomMessageProvenanceV1 as SharedAssemblyLoomMessageProvenanceV1,
  AssemblyMediaSegmentV1 as SharedAssemblyMediaSegmentV1,
  AssemblyMessageSourceKindV1,
  AssemblyOrdinaryMessageProvenanceV1 as SharedAssemblyOrdinaryMessageProvenanceV1,
  AssemblyOrdinaryProviderMessageV1 as SharedAssemblyOrdinaryProviderMessageV1,
  AssemblyPlanV1 as SharedAssemblyPlanV1,
  AssemblyProfileOutputLimitV1,
  AssemblyResultSlotSegmentV1 as SharedAssemblyResultSlotSegmentV1,
  AssemblyResultSlotV1 as SharedAssemblyResultSlotV1,
  AssemblyTokenEvidenceV1,
  InputRevisionSetV1,
  PreparationLimitsV1,
} from "../types/agent-preprocessing";
import type {
  CognitionLoomBlockRefV1,
  CognitionSourceSnapshotV1,
  LoomPolicyBucketV1,
  LoomPolicyBucketsV1,
  LoomPolicyEntryV1,
  LoomPolicySourceV1,
  LoomPromptInspectionBlockV1,
  LoomPromptInspectionV1,
} from "../types/agent-cognition";
import {
  LOOM_BUCKET_DESTINATION,
  normalizeLoomPolicyBucketsV1,
  parseLoomPolicyBuckets,
  parseLoomPromptInspectionV1,
} from "./agent-cognition.service";
import type {
  GenerationAssemblySnapshotV1,
  SnapshotBlockV1,
  SnapshotDatabankProvenanceV1,
  SnapshotMessageV1,
} from "./prompt-assembly-snapshot.service";
import { compareUtf8 } from "../utils/utf8-order";
const RESULT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const OPEN_PREFIX = "{{agent::";
const CLOSE_TAG = "{{/agent}}";
/** UTF-8 ceiling for one authored child token. 4 is the tokenizer lower bound, not a safe published max. */
const CHILD_RESULT_BYTES_PER_AUTHORED_TOKEN = 16;
const RESULT_PREFIX = "{{agentResult::";
const encoder = new TextEncoder();

export const AGENT_ASSEMBLY_PROTOCOL_VERSION = 1 as const;
export const AGENT_ASSEMBLY_OPERATION = "compile_agent_assembly" as const;


export type AssemblyPlanFailureCode =
  | "invalid_input"
  | "limit_exceeded"
  | "requires_response_mode"
  | "nested_result_reference"
  | "generated_result_reference"
  | "transformed_result_reference"
  | "recursive_result_reference"
  | "out_of_order_result_reference"
  | "missing_result_producer"
  | "duplicate_result_producer"
  | "invalid_intrinsic";

export class AssemblyPlanValidationError extends Error {
  readonly code: AssemblyPlanFailureCode;
  readonly blockIndex: number | null;
  readonly blockId: string | null;

  constructor(
    code: AssemblyPlanFailureCode,
    message: string,
    blockIndex: number | null = null,
    blockId: string | null = null,
  ) {
    super(message);
    this.name = "AssemblyPlanValidationError";
    this.code = code;
    this.blockIndex = blockIndex;
    this.blockId = blockId;
  }
}

export type AssemblyLiteralSegmentV1 = SharedAssemblyLiteralSegmentV1 & { readonly bytes: number };
export type AssemblyResultSlotSegmentV1 = SharedAssemblyResultSlotSegmentV1 & {
  readonly resultName: string;
  readonly maxBytes: number;
  readonly bytes: 0;
};
export type AssemblyMediaSegmentV1 = SharedAssemblyMediaSegmentV1 & { readonly bytes: 0 };
export type AssemblyMessageSegmentV1 =
  | AssemblyLiteralSegmentV1
  | AssemblyResultSlotSegmentV1
  | AssemblyMediaSegmentV1;
export type AssemblyLoomMessageProvenanceV1 = SharedAssemblyLoomMessageProvenanceV1;
export type AssemblyOrdinaryMessageProvenanceV1 = SharedAssemblyOrdinaryMessageProvenanceV1;
export type AssemblyCompiledPolicyMessageProvenanceV1 = SharedAssemblyCompiledPolicyMessageProvenanceV1;
export type AssemblyMessageProvenanceV1 =
  | AssemblyOrdinaryMessageProvenanceV1
  | AssemblyCompiledPolicyMessageProvenanceV1;
type AssemblyProviderMessageFieldsV1 = {
  readonly name?: string;
  readonly blockIndex?: number;
  readonly blockId?: string;
  readonly contentKind: "segments";
  readonly segments: readonly AssemblyMessageSegmentV1[];
};
export type AssemblyOrdinaryProviderMessageV1 = SharedAssemblyOrdinaryProviderMessageV1
  & AssemblyProviderMessageFieldsV1
  & { readonly provenance: AssemblyOrdinaryMessageProvenanceV1 };
export type AssemblyCompiledPolicyProviderMessageV1 = SharedAssemblyCompiledPolicyProviderMessageV1
  & AssemblyProviderMessageFieldsV1
  & { readonly provenance: AssemblyCompiledPolicyMessageProvenanceV1 };
export type AssemblyProviderMessageV1 =
  | AssemblyOrdinaryProviderMessageV1
  | AssemblyCompiledPolicyProviderMessageV1;

export type AssemblyChildDescriptorV1 = SharedAssemblyChildDescriptorV1 & {
  readonly slotIndex: number;
  readonly traversalIndex: number;
  readonly blockIndex: number;
  readonly blockId: string;
  readonly resultName: string | null;
  readonly taskBytes: number;
  readonly producerSeal: string;
};

export type AssemblyResultSlotV1 = SharedAssemblyResultSlotV1 & {
  readonly resultName: string;
  readonly producerBlockIndex: number;
  readonly producerBlockId: string;
  readonly seal: string;
};

export interface AssemblySealV1 {
  readonly kind: "producer" | "consumer";
  readonly resultName: string;
  readonly slotIndex: number;
  readonly blockIndex: number;
  readonly blockId: string;
  readonly sequence: number;
}

export interface AssemblyCognitionEvidenceV1 {
  readonly kind: "cognition_phase";
  readonly phase: "WORK" | "PREPARE_COMMIT" | "RENDER";
  readonly section: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy";
  readonly blockId: string;
  readonly expectedPresetRevision: number;
  readonly expectedBlockRevision: number;
  readonly actualPresetRevision: number;
  readonly actualBlockRevision: number;
  readonly order: number;
  readonly promptOrder: number;
  readonly decision: "selected";
  readonly ruleSourceRevision: string;
  readonly tokenCost: number;
  readonly byteCost: number;
}

export interface AssemblyPrivateEvidenceV1 {
  readonly activation: readonly Readonly<Record<string, unknown>>[];
  readonly cognition: readonly AssemblyCognitionEvidenceV1[];
  readonly token: Readonly<Record<string, unknown>>;
  readonly inputRevisionDigest: string;
}

export type AssemblyPlanV1 = SharedAssemblyPlanV1 & {
  readonly assemblySurface: AssemblySurfaceV1;

  readonly providerMessages: readonly AssemblyProviderMessageV1[];
  readonly messages: readonly AssemblyProviderMessageV1[];
  readonly children: readonly AssemblyChildDescriptorV1[];
  readonly childDescriptors: readonly AssemblyChildDescriptorV1[];
  readonly resultSlots: readonly AssemblyResultSlotV1[];
  readonly profileOutputLimits: readonly AssemblyProfileOutputLimitV1[];
  readonly seals: readonly AssemblySealV1[];
  readonly privateEvidence: AssemblyPrivateEvidenceV1;
  readonly deferredDeltas: readonly Readonly<Record<string, unknown>>[];
  readonly inputRevisionSet: InputRevisionSetV1;
  /** Canonical ordered custom WORK phase plan; never part of the four Loom buckets. */
  readonly customPhasePlan: AgentRuntimePhaseCompileResultV1;
  readonly workPolicyMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  readonly workspaceUsageMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  readonly completionCriteriaMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  readonly renderPolicyMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  /** Canonical Loom authoring retained beside materialized phase projections. */
  readonly loomPolicy: LoomPolicyBucketsV1;
  readonly loomBlocks: readonly LoomPromptInspectionBlockV1[];
  readonly snapshotId: string;
};

export interface CompileAgentAssemblyRequestV1 {
  readonly version: 1;
  readonly operation: typeof AGENT_ASSEMBLY_OPERATION;
  readonly requestId: string;
  readonly snapshot: GenerationAssemblySnapshotV1;
  readonly agentConfig?: unknown;
}

interface ParsedReference {
  readonly resultName: string;
  readonly start: number;
  readonly end: number;
}
interface ParsedChild {
  readonly profileId: string;
  readonly resultName: string | null;
  readonly task: string;
  readonly toolIds: readonly string[];
  readonly failurePolicy: "required" | "optional";
  readonly stream: boolean;
  readonly start: number;
  readonly end: number;
}

interface InternalBlockPlan {
  readonly block: SnapshotBlockV1;
  readonly blockIndex: number;
  readonly references: readonly ParsedReference[];
  readonly child: ParsedChild | null;
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}
function assertPreparationLimits(value: unknown): PreparationLimitsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly limits are not an object");
  }
  const candidate = value as Partial<PreparationLimitsV1>;
  const keys: readonly (keyof PreparationLimitsV1)[] = [
    "maxInputBytes", "maxOutputBytes", "maxCumulativeExpansionBytes", "maxOperationBytes",
    "maxPromptBlocks", "maxActiveScripts", "maxCompiledPatterns", "maxMacroResolutions",
    "maxTrimStrings", "maxCooperativeCpuMs", "maxWallClockMs", "maxWorkers",
    "maxQueuedJobsPerUser", "maxQueuedJobsProcess",
  ];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key as keyof PreparationLimitsV1))) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly limits are not closed");
  }
  for (const key of keys) {
    const actual = candidate[key];
    const host = HOST_PREPARATION_LIMITS_V1[key];
    if (typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid assembly limit");
    }
    if (actual > host) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Assembly limit exceeds host ceiling");
    }
  }
  return value as PreparationLimitsV1;
}


function frozen<T>(value: T): T {
  return Object.freeze(value);
}

function canonical(value: unknown, maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes): string {
  try {
    return encodeCanonicalPlainData(value, { maxBytes });
  } catch (error) {
    if (error instanceof CanonicalDataError) {
      throw new AssemblyPlanValidationError(error.code, `Canonical assembly data is invalid (${error.dimension ?? "value"})`);
    }
    throw error;
  }
}

export function validateAssemblySnapshotDataV1(
  value: unknown,
  options: { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxBytes?: number } = {},
): void {
  try {
    validateCanonicalPlainData(value, {
      maxDepth: options.maxDepth,
      maxNodes: options.maxNodes,
      maxBytes: options.maxBytes ?? HOST_PREPARATION_LIMITS_V1.maxInputBytes,
    });
  } catch (error) {
    if (error instanceof CanonicalDataError) {
      throw new AssemblyPlanValidationError(error.code, `Assembly snapshot data is invalid (${error.dimension ?? "value"})`);
    }
    throw error;
  }
}
function digest(value: unknown): string {
  let hash = 2166136261;
  for (const char of canonical(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function shaDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
const SNAPSHOT_KEYS = new Set([
  "version", "snapshotId", "assemblySurface", "userId", "generationId", "chatId", "target", "chat",
  "messages", "preset", "blocks", "participants", "variables", "regexScripts",
  "worldInfo", "databank", "agentCognition", "availability", "connection",
  "agentConfig", "limits", "inputRevisionSet", "revisions", "extensionData",
  "ambientSpindleData",
]);

function isPlainSnapshotData(
  value: unknown,
  maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes,
): boolean {
  try {
    validateCanonicalPlainData(value, { maxBytes });
    return true;
  } catch (error) {
    if (error instanceof CanonicalDataError && error.code === "limit_exceeded") {
      throw new AssemblyPlanValidationError(error.code, `Assembly snapshot data exceeds ${error.dimension ?? "the"} limit`);
    }
    return false;
  }
}

function validateNestedSnapshotRecords(candidate: Record<string, unknown>, limits: PreparationLimitsV1): void {
  const fail = (message: string): never => {
    throw new AssemblyPlanValidationError("invalid_input", `Invalid assembly snapshot ${message}`);
  };
  const record = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} record`);
    return value as Record<string, unknown>;
  };
  const closed = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
    if (Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} contains an unknown field`);
  };
  const text = (value: unknown, label: string, max = 256): void => {
    if (typeof value !== "string" || value.length === 0 || bytes(value) > max) fail(`${label} is invalid`);
  };
  const optionalText = (value: unknown, label: string, max = 256): void => {
    if (value !== undefined && value !== null && (typeof value !== "string" || bytes(value) > max)) fail(`${label} is invalid`);
  };
  const finite = (value: unknown, label: string): void => {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is invalid`);
  };
  const target = record(candidate.target, "target");
  closed(target, ["generationType", "messageId", "swipeId", "continueMessageId", "excludedMessageId", "userInput"], "target");
  if (!["normal", "continue", "regenerate", "swipe"].includes(String(target.generationType))) fail("target generation type");
  for (const key of ["messageId", "continueMessageId", "excludedMessageId"]) optionalText(target[key], `target.${key}`);
  if (typeof target.userInput !== "string" || bytes(target.userInput) > limits.maxInputBytes) fail("target.userInput");
  const databank = candidate.databank;
  if (databank !== undefined) {
    const databankRecord = record(databank, "databank");
    closed(databankRecord, [
      "enabled", "activeBankIds", "automaticChunks", "automaticFormatted",
      "mentions", "strippedUserInput", "mentionAppendix", "provenance",
    ], "databank");
    if (typeof databankRecord.enabled !== "boolean") fail("databank.enabled");
    if (
      !Array.isArray(databankRecord.activeBankIds)
      || databankRecord.activeBankIds.length > limits.maxPromptBlocks * 16
      || databankRecord.activeBankIds.some((id) => typeof id !== "string" || id.length === 0 || bytes(id) > 256)
    ) fail("databank.activeBankIds");
    if (typeof databankRecord.automaticFormatted !== "string" || bytes(databankRecord.automaticFormatted) > limits.maxInputBytes) {
      fail("databank.automaticFormatted");
    }
    if (typeof databankRecord.strippedUserInput !== "string" || bytes(databankRecord.strippedUserInput) > limits.maxInputBytes) {
      fail("databank.strippedUserInput");
    }
    if (typeof databankRecord.mentionAppendix !== "string" || bytes(databankRecord.mentionAppendix) > limits.maxInputBytes) {
      fail("databank.mentionAppendix");
    }
    const automaticChunks = databankRecord.automaticChunks;
    if (!Array.isArray(automaticChunks) || automaticChunks.length > limits.maxPromptBlocks * 16) fail("databank.automaticChunks");
    for (const [index, raw] of (automaticChunks as readonly unknown[]).entries()) {
      const chunk = record(raw, `databank.automaticChunks[${index}]`);
      closed(chunk, [
        "chunkId", "documentId", "databankId", "documentName", "content", "score",
        "documentContentHash", "contentHash",
      ], `databank.automaticChunks[${index}]`);
      text(chunk.chunkId, `databank.automaticChunks[${index}].chunkId`);
      text(chunk.documentId, `databank.automaticChunks[${index}].documentId`);
      text(chunk.databankId, `databank.automaticChunks[${index}].databankId`);
      if (typeof chunk.documentName !== "string" || bytes(chunk.documentName) > limits.maxOperationBytes) fail(`databank.automaticChunks[${index}].documentName`);
      if (typeof chunk.content !== "string" || bytes(chunk.content) > limits.maxOperationBytes) fail(`databank.automaticChunks[${index}].content`);
      if (chunk.score !== null && (typeof chunk.score !== "number" || !Number.isFinite(chunk.score))) fail(`databank.automaticChunks[${index}].score`);
      if (chunk.documentContentHash !== null && (!/^[a-f0-9]{64}$/.test(String(chunk.documentContentHash)))) fail(`databank.automaticChunks[${index}].documentContentHash`);
      if (!/^[a-f0-9]{64}$/.test(String(chunk.contentHash))) fail(`databank.automaticChunks[${index}].contentHash`);
    }
    const mentions = databankRecord.mentions;
    if (!Array.isArray(mentions) || mentions.length > limits.maxPromptBlocks * 16) fail("databank.mentions");
    for (const [index, raw] of (mentions as readonly unknown[]).entries()) {
      const mention = record(raw, `databank.mentions[${index}]`);
      closed(mention, [
        "slug", "documentId", "databankId", "documentName", "content", "truncated",
        "documentContentHash", "contentHash",
      ], `databank.mentions[${index}]`);
      text(mention.slug, `databank.mentions[${index}].slug`);
      text(mention.documentId, `databank.mentions[${index}].documentId`);
      text(mention.databankId, `databank.mentions[${index}].databankId`);
      if (typeof mention.documentName !== "string" || bytes(mention.documentName) > limits.maxOperationBytes) fail(`databank.mentions[${index}].documentName`);
      if (typeof mention.content !== "string" || bytes(mention.content) > limits.maxOperationBytes) fail(`databank.mentions[${index}].content`);
      if (typeof mention.truncated !== "boolean") fail(`databank.mentions[${index}].truncated`);
      if (mention.documentContentHash !== null && (!/^[a-f0-9]{64}$/.test(String(mention.documentContentHash)))) fail(`databank.mentions[${index}].documentContentHash`);
      if (!/^[a-f0-9]{64}$/.test(String(mention.contentHash))) fail(`databank.mentions[${index}].contentHash`);
    }
    const provenance = databankRecord.provenance;
    if (!Array.isArray(provenance) || provenance.length > limits.maxPromptBlocks * 32) fail("databank.provenance");
    const automaticSources: unknown[] = [];
    const mentionSources: unknown[] = [];
    for (const entry of provenance as readonly unknown[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("databank.provenance");
      const kind = (entry as Record<string, unknown>).kind;
      if (kind === "automatic") automaticSources.push(entry);
      else if (kind === "mention") mentionSources.push(entry);
      else fail("databank.provenance");
    }
    if (
      !isValidDatabankMessageProvenance({ kind: "automatic", sources: automaticSources })
      || !isValidDatabankMessageProvenance({ kind: "mention", sources: mentionSources })
    ) fail("databank.provenance");
  }

  const chat = record(candidate.chat, "chat");
  closed(chat, ["id", "character_id", "name", "metadata", "created_at", "updated_at", "revision"], "chat");
  text(chat.id, "chat.id");
  optionalText(chat.character_id, "chat.character_id");
  if (typeof chat.name !== "string" || bytes(chat.name) > limits.maxInputBytes) fail("chat.name");
  if (!isPlainSnapshotData(chat.metadata)) fail("chat.metadata");
  finite(chat.created_at, "chat.created_at");
  finite(chat.updated_at, "chat.updated_at");
  text(chat.revision, "chat.revision");
  if (!Array.isArray(candidate.messages)) fail("messages collection");
  const messages = candidate.messages as readonly unknown[];
  let nativeMediaPartCount = 0;
  let nativeMediaTotalBytes = 0;
  for (const [index, raw] of messages.entries()) {
    const message = record(raw, `message[${index}]`);
    closed(message, [
      "id", "chat_id", "index_in_chat", "is_user", "name", "content", "send_date",
      "swipe_id", "swipes", "swipe_dates", "extra", "parent_message_id", "branch_id", "created_at", "revision", "mediaParts",
    ], `message[${index}]`);
    const mediaParts: unknown[] = Array.isArray(message.mediaParts)
      ? message.mediaParts
      : fail(`message[${index}].mediaParts`);
    for (const [mediaIndex, rawMedia] of mediaParts.entries()) {
      const media = record(rawMedia, `message[${index}].mediaParts[${mediaIndex}]`);
      closed(media, ["kind", "mediaType", "mediaId", "mimeType", "byteLength", "sha256"], `message[${index}].mediaParts[${mediaIndex}]`);
      const mediaByteLength = media.byteLength;
      const mediaLimit = media.mediaType === "image" ? MAX_IMAGE_BYTES : media.mediaType === "audio" ? MAX_AUDIO_BYTES : 0;
      if (
        media.kind !== "media"
        || typeof media.mediaId !== "string"
        || media.mediaId.length === 0
        || bytes(media.mediaId) > 256
        || typeof media.mimeType !== "string"
        || !/^(?:image|audio)\/[a-z0-9.+-]{1,96}$/.test(media.mimeType)
        || typeof mediaByteLength !== "number"
        || !Number.isSafeInteger(mediaByteLength)
        || mediaByteLength < 1
        || mediaByteLength > mediaLimit
        || typeof media.sha256 !== "string"
        || !/^[0-9a-f]{64}$/.test(media.sha256)
        || message.is_user !== true
      ) fail(`message[${index}].mediaParts[${mediaIndex}]`);
      if (typeof mediaByteLength === "number") {
        nativeMediaPartCount += 1;
        if (
          nativeMediaPartCount > MAX_NATIVE_MESSAGE_MEDIA_PARTS
          || mediaByteLength > MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES - nativeMediaTotalBytes
        ) fail("message[" + index + "].mediaParts limits");
        nativeMediaTotalBytes += mediaByteLength;
      } else {
        fail("message[" + index + "].mediaParts[" + mediaIndex + "]");
      }
    }
    text(message.id, `message[${index}].id`);
    text(message.chat_id, `message[${index}].chat_id`);
    if (!Number.isSafeInteger(message.index_in_chat) || (message.index_in_chat as number) < 0) fail(`message[${index}].index_in_chat`);
    if (typeof message.is_user !== "boolean") fail(`message[${index}].is_user`);
    if (typeof message.name !== "string" || bytes(message.name) > limits.maxInputBytes) fail(`message[${index}].name`);
    if (typeof message.content !== "string" || bytes(message.content) > limits.maxInputBytes) fail(`message[${index}].content`);
    finite(message.send_date, `message[${index}].send_date`);
    if (!Number.isSafeInteger(message.swipe_id) || (message.swipe_id as number) < 0) fail(`message[${index}].swipe_id`);
    if (!Array.isArray(message.swipes)) fail(`message[${index}].swipes`);
    const swipes = message.swipes as readonly unknown[];
    if (swipes.some((value) => typeof value !== "string" || bytes(value) > limits.maxInputBytes)) fail(`message[${index}].swipes`);
    if (!Array.isArray(message.swipe_dates) || (message.swipe_dates as readonly unknown[]).some((value) => typeof value !== "number" || !Number.isFinite(value))) fail(`message[${index}].swipe_dates`);
    if (!isPlainSnapshotData(message.extra)) fail(`message[${index}].extra`);
    optionalText(message.parent_message_id, `message[${index}].parent_message_id`);
    optionalText(message.branch_id, `message[${index}].branch_id`);
    finite(message.created_at, `message[${index}].created_at`);
    text(message.revision, `message[${index}].revision`);
  }
  if (!Array.isArray(candidate.blocks)) fail("blocks collection");
  const blocks = candidate.blocks as readonly unknown[];
  const blockKeys = [
    "id", "name", "content", "role", "enabled", "position", "depth", "marker", "isLocked", "color",
    "injectionTrigger", "characterTagTrigger", "group", "categoryMode", "variables", "placementBinding",
    "stashId", "sealed", "sealedKey", "sealedSource", "sealedOriginPresetId", "sealedOriginVersion", "sealedSha256",
    "order", "revision",
  ] as const;
  for (const [index, raw] of blocks.entries()) {
    const block = record(raw, `block[${index}]`);
    closed(block, blockKeys, `block[${index}]`);
    text(block.id, `block[${index}].id`);
    if (typeof block.content !== "string" || bytes(block.content) > limits.maxInputBytes) fail(`block[${index}].content`);
    if (!["system", "user", "assistant", "user_append", "assistant_append"].includes(String(block.role))) fail(`block[${index}].role`);
    if (typeof block.enabled !== "boolean") fail(`block[${index}].enabled`);
    if (!["pre_history", "post_history", "in_history"].includes(String(block.position))) fail(`block[${index}].position`);
    if (!Number.isSafeInteger(block.depth) || (block.depth as number) < 0) fail(`block[${index}].depth`);
    if (block.marker !== null && typeof block.marker !== "string") fail(`block[${index}].marker`);
    if (typeof block.isLocked !== "boolean") fail(`block[${index}].isLocked`);
    if (block.color !== null && typeof block.color !== "string") fail(`block[${index}].color`);
    if (!Array.isArray(block.injectionTrigger) || block.injectionTrigger.some((value) => typeof value !== "string")) fail(`block[${index}].injectionTrigger`);
    if (block.characterTagTrigger !== undefined && (!Array.isArray(block.characterTagTrigger) || block.characterTagTrigger.some((value) => typeof value !== "string"))) fail(`block[${index}].characterTagTrigger`);
    if (block.group !== null && typeof block.group !== "string") fail(`block[${index}].group`);
    if (block.categoryMode !== null && block.categoryMode !== undefined && !["radio", "checkbox"].includes(String(block.categoryMode))) fail(`block[${index}].categoryMode`);
    if (block.variables !== undefined && !isPlainSnapshotData(block.variables)) fail(`block[${index}].variables`);
    if (block.placementBinding !== undefined && !isPlainSnapshotData(block.placementBinding)) fail(`block[${index}].placementBinding`);
    for (const key of ["stashId", "sealedKey", "sealedSource", "sealedOriginPresetId", "sealedSha256"]) optionalText(block[key], `block[${index}].${key}`, limits.maxInputBytes);
    if (typeof block.sealed !== "boolean") fail(`block[${index}].sealed`);
    if (block.sealedOriginVersion !== undefined && block.sealedOriginVersion !== null && typeof block.sealedOriginVersion !== "string") fail(`block[${index}].sealedOriginVersion`);
    if (!Number.isSafeInteger(block.order) || (block.order as number) < 0) fail(`block[${index}].order`);
    text(block.revision, `block[${index}].revision`);
  }
}

function validateSnapshotIdentity(snapshot: unknown): asserts snapshot is GenerationAssemblySnapshotV1 {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new AssemblyPlanValidationError("invalid_input", "Invalid assembly snapshot");
  }
  // Inspect and canonicalize before reading any host-owned field. The
  // iterative plain-data walk rejects accessors/proxies/functions and unsafe
  // numbers without recursion.
  canonical(snapshot, HOST_PREPARATION_LIMITS_V1.maxInputBytes + HOST_PREPARATION_LIMITS_V1.maxOutputBytes);
  const candidate = snapshot as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !SNAPSHOT_KEYS.has(key))) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly snapshot contains an unknown field");
  }
  if (candidate.assemblySurface === "RESPONSE") {
    throw new AssemblyPlanValidationError("invalid_input", "Strict agent assembly requires the WORK surface");
  }
  if (
    candidate.version !== 1
    || (candidate.assemblySurface !== "RESPONSE" && candidate.assemblySurface !== "WORK")
    || typeof candidate.snapshotId !== "string"
    || candidate.snapshotId.length === 0
    || bytes(candidate.snapshotId) > 256
    || !candidate.limits
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly snapshot envelope is invalid");
  }
  const limits = assertPreparationLimits(candidate.limits);
  if (!isPlainSnapshotData(snapshot, limits.maxInputBytes)) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly snapshot is not closed plain data");
  }
  validateNestedSnapshotRecords(candidate, limits);
  if (bytes(canonical(snapshot, limits.maxInputBytes)) > limits.maxInputBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Assembly snapshot exceeds the input limit");
  }
  if (
    !Array.isArray(candidate.blocks)
    || candidate.blocks.length > limits.maxPromptBlocks
    || !Array.isArray(candidate.messages)
    || candidate.messages.length > limits.maxPromptBlocks * 16
    || !candidate.inputRevisionSet
    || !candidate.revisions
    || canonical(candidate.inputRevisionSet) !== canonical(candidate.revisions)
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly snapshot identity is incomplete");
  }
  const revisionSet = candidate.revisions as Record<string, unknown>;
  if (
    !Array.isArray(revisionSet.revisions)
    || typeof revisionSet.digest !== "string"
    || shaDigest(revisionSet.revisions) !== revisionSet.digest
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly input revision digest is invalid");
  }
  const { snapshotId: _snapshotId, inputRevisionSet: _inputRevisionSet, revisions: _revisions, ...base } = candidate;
  if (shaDigest({ base, revisions: candidate.revisions }) !== candidate.snapshotId) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly snapshot identity mismatch");
  }
}


function failForBlock(code: AssemblyPlanFailureCode, message: string, block: SnapshotBlockV1, index: number): never {
  throw new AssemblyPlanValidationError(code, message, index, block.id);
}

function scanReferences(content: string, block: SnapshotBlockV1, blockIndex: number): ParsedReference[] {
  const references: ParsedReference[] = [];
  let cursor = 0;
  while (true) {
    const marker = content.indexOf("{{agentResult", cursor);
    if (marker < 0) break;
    if (!content.startsWith(RESULT_PREFIX, marker)) {
      failForBlock("invalid_input", "Malformed agent result reference", block, blockIndex);
    }
    const end = content.indexOf("}}", marker + RESULT_PREFIX.length);
    if (end < 0) failForBlock("invalid_input", "Unclosed agent result reference", block, blockIndex);
    const resultName = content.slice(marker + RESULT_PREFIX.length, end);
    if (!RESULT_NAME_PATTERN.test(resultName)) {
      failForBlock("invalid_input", "Invalid agent result name", block, blockIndex);
    }
    // A result token is a literal segment boundary. If another macro is open
    // around it, a macro/interceptor could transform or generate the token;
    // strict Agentic preparation rejects that form instead of guessing.
    const before = content.slice(0, marker);
    const lastOpen = before.lastIndexOf("{{");
    const lastClose = before.lastIndexOf("}}");
    if (lastOpen > lastClose) {
      failForBlock("transformed_result_reference", "Agent result reference is inside another macro", block, blockIndex);
    }
    const after = content.slice(end + 2);
    const nextOpen = after.indexOf("{{");
    const nextClose = after.indexOf("}}");
    if (nextClose >= 0 && (nextOpen < 0 || nextClose < nextOpen)) {
      failForBlock("transformed_result_reference", "Agent result reference has an enclosing transform", block, blockIndex);
    }
    references.push({ resultName, start: marker, end: end + 2 });
    cursor = end + 2;
  }
  return references;
}

function parseChildOpening(block: SnapshotBlockV1, blockIndex: number): ParsedChild | null {
  const content = block.content;
  if (!content.startsWith(OPEN_PREFIX)) return null;
  const openEnd = content.indexOf("}}", OPEN_PREFIX.length);
  if (openEnd < 0) failForBlock("invalid_intrinsic", "Malformed agent intrinsic opening", block, blockIndex);
  const opening = content.slice(OPEN_PREFIX.length, openEnd);
  const parts = opening.split("::");
  const profileId = parts.shift() ?? "";
  if (!RESULT_NAME_PATTERN.test(profileId)) failForBlock("invalid_intrinsic", "Invalid agent profile id", block, blockIndex);
  let resultName: string | null = null;
  let toolIds: string[] = [];
  let stream = false;
  for (const option of parts) {
    const equal = option.indexOf("=");
    const key = equal < 0 ? option : option.slice(0, equal);
    const value = equal < 0 ? "" : option.slice(equal + 1);
    if (key === "stream" && equal < 0) {
      stream = true;
    } else if (key === "as" && RESULT_NAME_PATTERN.test(value)) {
      if (resultName) failForBlock("invalid_intrinsic", "Duplicate result name option", block, blockIndex);
      resultName = value;
    } else if (key === "tools" && value.length > 0) {
      toolIds = value.split(",").filter((id) => id.length > 0);
      if (new Set(toolIds).size !== toolIds.length) failForBlock("invalid_intrinsic", "Duplicate child tool", block, blockIndex);
    } else {
      failForBlock("invalid_intrinsic", "Unknown or malformed intrinsic option", block, blockIndex);
    }
  }
  const close = content.indexOf(CLOSE_TAG, openEnd + 2);
  if (close < 0 || close + CLOSE_TAG.length !== content.length) {
    failForBlock("invalid_intrinsic", "Malformed agent intrinsic closing", block, blockIndex);
  }
  const task = content.slice(openEnd + 2, close);
  if (task.trim().length === 0) failForBlock("invalid_intrinsic", "Empty agent intrinsic task", block, blockIndex);
  if (task.includes("{{agentResult")) failForBlock("recursive_result_reference", "Child task contains an agent result reference", block, blockIndex);
  if (task.includes(OPEN_PREFIX) || task.includes(CLOSE_TAG)) failForBlock("recursive_result_reference", "Nested agent intrinsic", block, blockIndex);
  return { profileId, resultName, task, toolIds, failurePolicy: "required", stream, start: 0, end: content.length };
}
const DIRECT_RESULT_MARKER_RE = /\{\{agentResult::[^}]*\}\}/g;

interface SnapshotPreprocessingResult {
  readonly blocks: readonly SnapshotBlockV1[];
  readonly history: readonly AssemblyProviderMessageV1[];
  readonly worldInfo: SnapshotWorldPreparationV1;
  readonly worldBefore: readonly AssemblyProviderMessageV1[];
  readonly worldAfter: readonly AssemblyProviderMessageV1[];
  readonly worldAnBefore: readonly AssemblyProviderMessageV1[];
  readonly worldAnAfter: readonly AssemblyProviderMessageV1[];
  readonly worldEmBefore: readonly AssemblyProviderMessageV1[];
  readonly worldEmAfter: readonly AssemblyProviderMessageV1[];
  readonly worldDepth: readonly Readonly<{ message: AssemblyProviderMessageV1; depth: number }>[];
  readonly worldRuntime: readonly Readonly<{ message: AssemblyProviderMessageV1; direction: "from_start" | "from_end"; depth: number }>[];
  readonly deltas: readonly PreparationDeltaV1[];
  readonly macroEvidence: readonly Readonly<Record<string, unknown>>[];
  readonly regexEvidence: readonly Readonly<Record<string, unknown>>[];
}
function snapshotUsesDatabankRetrievalMacro(blocks: readonly SnapshotBlockV1[]): boolean {
  for (const block of blocks) {
    if (!block.enabled || !block.content.includes("{{")) continue;
    for (const match of block.content.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*)/g)) {
      const definition = macroRegistry.getMacro(match[1]!);
      if (definition?.handlesDatabankRetrieval === true) return true;
    }
  }
  return false;
}

type AssemblyRole = AssemblyProviderMessageV1["role"];

function roleForWorldInfo(role: string | null | undefined): AssemblyRole {
  if (role === "user" || role === "assistant" || role === "tool" || role === "developer") return role;
  return "system";
}

function cacheItemText(item: Readonly<{ content: string }>): string {
  return item.content;
}

async function mapProtectedResultMarkers(
  content: string,
  transform: (text: string) => string | Promise<string>,
): Promise<string> {
  if (!content.includes("{{agentResult")) return await transform(content);
  let marker = content.indexOf("{{agentResult");
  while (marker >= 0) {
    const end = content.indexOf("}}", marker + "{{agentResult".length);
    if (end < 0) throw new Error("invalid_input: unclosed agent result reference");
    marker = content.indexOf("{{agentResult", end + 2);
  }
  DIRECT_RESULT_MARKER_RE.lastIndex = 0;
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of content.matchAll(DIRECT_RESULT_MARKER_RE)) {
    const start = match.index ?? 0;
    pieces.push(await transform(content.slice(cursor, start)));
    pieces.push(match[0]);
    cursor = start + match[0].length;
  }
  pieces.push(await transform(content.slice(cursor)));
  return pieces.join("");
}

function assertChildMarkersAreSealed(
  content: string,
  block: SnapshotBlockV1,
  blockIndex: number,
): boolean {
  const hasOpen = content.includes(OPEN_PREFIX);
  const hasClose = content.includes(CLOSE_TAG);
  if (!hasOpen && !hasClose) return false;
  if (!content.startsWith(OPEN_PREFIX)) {
    failForBlock("nested_result_reference", "Agent intrinsic markers must form a sealed child block", block, blockIndex);
  }
  if (!hasOpen || !hasClose) {
    failForBlock("invalid_intrinsic", "Unclosed agent intrinsic marker", block, blockIndex);
  }
  parseChildOpening(block, blockIndex);
  return true;
}

function projectStructuralBlockAdmission(
  block: SnapshotBlockV1,
  values: Readonly<Record<string, string>> | undefined,
): SnapshotBlockV1 {
  if (block.marker === null || !STRUCTURAL_PROMPT_MARKERS.has(block.marker)) return block;
  const content = values?.[block.id];
  return content === undefined
    ? frozen({ ...block, enabled: false, content: "" })
    : frozen({ ...block, content });
}
async function preprocessSnapshot(
  snapshot: GenerationAssemblySnapshotV1,
  phasePolicyBlockOccurrences: ReadonlySet<string> = new Set(),
  ignoredCognitionBlockOccurrences: ReadonlySet<string> = new Set(),
): Promise<SnapshotPreprocessingResult> {
  const worldInfo = activateSnapshotWorldInfo(snapshot);
  const env = buildSnapshotMacroEnv(snapshot);
  const budget = createSnapshotExpansionBudget(snapshot);
  const macroEvidence: Readonly<Record<string, unknown>>[] = [];
  const regexEvidence: Readonly<Record<string, unknown>>[] = [];
  const deltas: PreparationDeltaV1[] = [...worldInfo.stateDeltas];
  const sourceMessageDeltas: SourceMessageDeltaV1[] = [];
  let sourceDeltaBytes = 0;
  const maxSourceMessageDeltas = snapshot.limits.maxPromptBlocks * 16;
  const regexDeltaKeys = new Set<string>();
  const appendSourceMessageDelta = (message: SnapshotMessageV1, content: string): void => {
    if (sourceMessageDeltas.length >= maxSourceMessageDeltas) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Source-message delta count exceeds the limit");
    }
    if (!Number.isSafeInteger(message.swipe_id) || message.swipe_id < 0) {
      throw new AssemblyPlanValidationError("invalid_input", "Frozen source-message swipe identity is invalid");
    }
    const role = message.is_user ? "user" : "assistant";
    const deltaBytes = bytes(message.id)
      + bytes("update")
      + bytes(role)
      + bytes(content)
      + bytes(String(message.swipe_id))
      + bytes(String(message.revision));
    if (bytes(content) > snapshot.limits.maxOperationBytes || deltaBytes > snapshot.limits.maxOperationBytes) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Source-message delta exceeds the operation limit");
    }
    sourceDeltaBytes += deltaBytes;
    if (sourceDeltaBytes > snapshot.limits.maxOutputBytes) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Source-message deltas exceed the output limit");
    }
    sourceMessageDeltas.push(frozen({
      kind: "source_message",
      sourceMessageId: message.id,
      operation: "update",
      role,
      content,
      swipeId: message.swipe_id,
      expectedRevision: message.revision,
    }));
  };
  const outletValues: Record<string, string> = {};
  for (const entry of worldInfo.activatedEntries) {
    const outlet = typeof entry.outlet_name === "string" ? entry.outlet_name.trim().toLowerCase() : "";
    if (outlet && !Object.prototype.hasOwnProperty.call(outletValues, outlet)) outletValues[outlet] = entry.content;
  }
  env.extra.worldInfoOutlets = outletValues;
  env.extra.worldInfoAtMarker = worldInfo.cache.atMarker.map(cacheItemText).join("\n\n");

  const resolveText = async (
    raw: string,
    placement: "user_input" | "ai_output" | "world_info",
    block: SnapshotBlockV1 | null,
    blockIndex: number,
  ): Promise<string> => {
    try {
      const macroResolved = await mapProtectedResultMarkers(raw, async (text) => {
        const resolved = await resolveSnapshotMacroText(text, env, budget);
        if (agentMarkersPresent(resolved)) {
          throw new Error("generated_result_reference: macro generated a protected agent marker");
        }
        if (resolved !== text) {
          macroEvidence.push(frozen({
            kind: "macro",
            blockId: block?.id ?? null,
            operation: "resolve",
            inputBytes: bytes(text),
            outputBytes: bytes(resolved),
          }));
        }
        return resolved;
      });
      return await mapProtectedResultMarkers(macroResolved, (text) => {
        const before = text;
        const transformed = applySnapshotPromptRegex(
          text,
          snapshot.regexScripts,
          placement,
          snapshot.limits,
          budget,
        );
        if (transformed !== before) {
          for (const script of snapshot.regexScripts) {
            if (!script.target.includes("prompt") || !script.placement.includes(placement)) continue;
            let matched = false;
            try {
              const regex = new RegExp(script.findRegex, script.flags);
              regex.lastIndex = 0;
              matched = regex.test(before);
            } catch {
              continue;
            }
            if (!matched) continue;
            regexEvidence.push(frozen({
              kind: "regex",
              scriptId: script.id,
              operation: "apply",
              inputBytes: bytes(before),
              outputBytes: bytes(transformed),
            }));
            const deltaKey = `${script.id}\u0000${script.revision}`;
            if (regexDeltaKeys.has(deltaKey)) continue;
            regexDeltaKeys.add(deltaKey);
            deltas.push(frozen({
              kind: "regex_action",
              scriptId: script.id,
              operation: "apply",
              expectedRevision: script.revision,
            }));
          }
        }
        if (agentMarkersPresent(transformed)) {
          throw new Error("generated_result_reference: regex generated a protected agent marker");
        }
        return transformed;
      });
    } catch (error) {
      if (error instanceof AssemblyPlanValidationError) throw error;
      const message = error instanceof Error ? error.message : "unknown preprocessing failure";
      const code: AssemblyPlanFailureCode = message.startsWith("requires_response_mode:")
        ? "requires_response_mode"
        : message.startsWith("generated_result_reference:")
          ? "generated_result_reference"
          : message.startsWith("limit_exceeded:")
            ? "limit_exceeded"
            : "invalid_input";
      if (block) failForBlock(code, message, block, blockIndex);
      throw new AssemblyPlanValidationError(code, message);
    }
  };

  const resolveWorldText = async (text: string): Promise<string> => {
    if (agentMarkersPresent(text)) {
      throw new AssemblyPlanValidationError("invalid_input", "Agent markers cannot occur in world-info content");
    }
    return resolveText(text, "world_info", null, -1);
  };
  for (const entry of worldInfo.activatedEntries) {
    const outlet = typeof entry.outlet_name === "string" ? entry.outlet_name.trim().toLowerCase() : "";
    if (outlet) outletValues[outlet] = await resolveWorldText(entry.content);
  }
  const blocks: SnapshotBlockV1[] = [];
  const structuralBlockValues = snapshot.participants.structuralBlockValues;
  for (const [blockIndex, sourceBlock] of snapshot.blocks.entries()) {
    const block = projectStructuralBlockAdmission(sourceBlock, structuralBlockValues);
    if (ignoredCognitionBlockOccurrences.has(blockOccurrenceKey(block.id, blockIndex))) {
      blocks.push(frozen({ ...block, enabled: false, content: "" }));
      continue;
    }
    const child = assertChildMarkersAreSealed(block.content, block, blockIndex);
    if (child && phasePolicyBlockOccurrences.has(blockOccurrenceKey(block.id, blockIndex))) {
      failForBlock("requires_response_mode", "Cognition policy blocks cannot contain agent result references", block, blockIndex);
    }
    if (child && block.enabled) {
      const parsedChild = parseChildOpening(block, blockIndex);
      if (!parsedChild) {
        failForBlock("invalid_intrinsic", "Agent intrinsic markers must form a sealed child block", block, blockIndex);
      }
      setSnapshotBlockMacroContext(env, snapshot, block);
      let resolvedTask: string;
      try {
        resolvedTask = await resolveSnapshotMacroText(parsedChild.task, env, budget);
        if (agentMarkersPresent(resolvedTask)) {
          throw new Error("generated_result_reference: macro generated a protected agent marker");
        }
      } catch (error) {
        if (error instanceof AssemblyPlanValidationError) throw error;
        const message = error instanceof Error ? error.message : "unknown preprocessing failure";
        const code: AssemblyPlanFailureCode = message.startsWith("requires_response_mode:")
          ? "requires_response_mode"
          : message.startsWith("generated_result_reference:")
            ? "generated_result_reference"
            : message.startsWith("limit_exceeded:")
              ? "limit_exceeded"
              : "invalid_input";
        failForBlock(code, message, block, blockIndex);
      }
      if (resolvedTask !== parsedChild.task) {
        macroEvidence.push(frozen({
          kind: "macro",
          blockId: block.id,
          operation: "resolve",
          inputBytes: bytes(parsedChild.task),
          outputBytes: bytes(resolvedTask),
        }));
      }
      const openingEnd = block.content.indexOf("}}", OPEN_PREFIX.length) + 2;
      const resolvedBlock = frozen({
        ...block,
        content: block.content.slice(0, openingEnd) + resolvedTask + CLOSE_TAG,
      });
      parseChildOpening(resolvedBlock, blockIndex);
      blocks.push(resolvedBlock);
      continue;
    }
    if (!block.enabled) {
      blocks.push(block);
      continue;
    }
    setSnapshotBlockMacroContext(env, snapshot, block);
    const placement = block.role === "user"
      ? "user_input"
      : block.role === "assistant"
        ? "ai_output"
        : "world_info";
    const pinsBefore = worldInfo.cache.pinnedMarkers
      .filter((item) => item.marker.length > 0 && block.content.includes(item.marker) && item.side === "before")
      .map(cacheItemText);
    const pinsAfter = worldInfo.cache.pinnedMarkers
      .filter((item) => item.marker.length > 0 && block.content.includes(item.marker) && item.side === "after")
      .map(cacheItemText);
    for (const text of [...pinsBefore, ...pinsAfter]) {
      if (agentMarkersPresent(text)) {
        failForBlock("invalid_input", "Agent markers cannot occur in world-info content", block, blockIndex);
      }
    }
    const resolved = await resolveText(block.content, placement, block, blockIndex);
    const pinBeforeResolved: string[] = [];
    for (const text of pinsBefore) pinBeforeResolved.push(await resolveWorldText(text));
    const pinAfterResolved: string[] = [];
    for (const text of pinsAfter) pinAfterResolved.push(await resolveWorldText(text));
    const content = [
      ...pinBeforeResolved,
      resolved,
      ...pinAfterResolved,
    ].filter((text) => text.length > 0).join("\n\n");
    blocks.push(frozen({ ...block, content }));
  }
  env.promptBlock = undefined;
  const history: AssemblyProviderMessageV1[] = [];
  const historyCandidates = snapshot.messages.filter(
    (candidate) => candidate.id !== snapshot.target.excludedMessageId,
  );
  const currentUserIndex = historyCandidates.findLastIndex((candidate) => candidate.is_user);
  for (const [candidateIndex, message] of historyCandidates.entries()) {
    const sourceIndex = history.length;
    const selectedSwipe = Number.isSafeInteger(message.swipe_id)
      ? message.swipes[message.swipe_id]
      : undefined;
    const sourceContent = typeof selectedSwipe === "string"
      ? selectedSwipe
      : message.content;
    const useNativeMentionInput =
      candidateIndex === currentUserIndex
      && (snapshot.databank?.mentions.length ?? 0) > 0;
    const macroInput = useNativeMentionInput
      ? snapshot.databank!.strippedUserInput
      : sourceContent;
    const placement = message.is_user ? "user_input" : "ai_output";
    const resolved = await resolveText(macroInput, placement, null, -1);
    const content = useNativeMentionInput
      ? `${resolved}${snapshot.databank!.mentionAppendix}`
      : resolved;
    if (!useNativeMentionInput && content !== sourceContent) {
      appendSourceMessageDelta(message, content);
    }
    history.push(messageForHistory({ ...message, content }, snapshot.limits.maxOperationBytes, sourceIndex));
  }
  // Source deltas follow frozen history order, independent of regex-action
  // insertion order, so the deferred write intent is deterministic.
  deltas.push(...sourceMessageDeltas);
  const worldRuntime: Array<Readonly<{ message: AssemblyProviderMessageV1; direction: "from_start" | "from_end"; depth: number }>> = [];
  for (const [placementIndex, item] of worldInfo.runtimePlacements.entries()) {
    if (agentMarkersPresent(item.content)) {
      throw new AssemblyPlanValidationError("invalid_input", "Agent markers cannot occur in world-info content");
    }
    worldRuntime.push(frozen({
      message: messageForWorldInfo(
        await resolveWorldText(item.content),
        item.placement.role,
        snapshot.limits.maxOperationBytes,
        item.entryLabel,
        digest({ entryId: item.id, placement: item.placement, content: item.content }),
        history.length + placementIndex,
      ),
      direction: item.placement.direction,
      depth: Math.max(0, Math.floor(item.placement.depth)),
    }));
  }

  const worldContent = [
    ...worldInfo.cache.before,
    ...worldInfo.cache.anBefore,
    ...worldInfo.cache.emBefore,
    ...worldInfo.cache.depth,
    ...worldInfo.cache.emAfter,
    ...worldInfo.cache.anAfter,
    ...worldInfo.cache.after,
  ];
  for (const item of worldContent) {
    if (agentMarkersPresent(item.content)) {
      throw new AssemblyPlanValidationError("invalid_input", "Agent markers cannot occur in world-info content");
    }
  }
  const worldSourceRevision = (item: { content: string; entryLabel: string }): string =>
    digest({ entryLabel: item.entryLabel, content: item.content });
  let worldSourceIndex = 0;
  const worldMessages = async <T extends { content: string; entryLabel: string; role: string }>(
    items: readonly T[],
  ): Promise<AssemblyProviderMessageV1[]> => {
    const messages: AssemblyProviderMessageV1[] = [];
    for (const item of items) {
      messages.push(messageForWorldInfo(
        await resolveWorldText(item.content),
        item.role,
        snapshot.limits.maxOperationBytes,
        item.entryLabel,
        worldSourceRevision(item),
        worldSourceIndex++,
      ));
    }
    return messages;
  };
  const worldBefore = await worldMessages(worldInfo.cache.before);
  const worldAfter = await worldMessages(worldInfo.cache.after);
  const worldAnBefore = await worldMessages(worldInfo.cache.anBefore);
  const worldAnAfter = await worldMessages(worldInfo.cache.anAfter);
  const worldEmBefore = await worldMessages(worldInfo.cache.emBefore);
  const worldEmAfter = await worldMessages(worldInfo.cache.emAfter);
  const worldDepthMessages = await worldMessages(worldInfo.cache.depth);
  const worldDepth = worldDepthMessages.map((message, index) => frozen({
    message,
    depth: Math.max(0, Math.floor(worldInfo.cache.depth[index]!.depth)),
  }));
  return frozen({
    blocks: frozen(blocks),
    history: frozen(history),
    worldInfo,
    worldBefore: frozen(worldBefore),
    worldAfter: frozen(worldAfter),
    worldAnBefore: frozen(worldAnBefore),
    worldAnAfter: frozen(worldAnAfter),
    worldEmBefore: frozen(worldEmBefore),
    worldEmAfter: frozen(worldEmAfter),
    worldDepth: frozen(worldDepth),
    worldRuntime: frozen(worldRuntime),
    deltas: frozen(deltas),
    macroEvidence: frozen(macroEvidence),
    regexEvidence: frozen(regexEvidence),
  });
}

function configFor(snapshot: GenerationAssemblySnapshotV1, explicit: unknown): unknown {
  if (explicit === undefined) return snapshot.agentConfig;
  if (!isPlainSnapshotData(explicit)) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly config is not closed plain data");
  }
  if (canonical(explicit) !== canonical(snapshot.agentConfig)) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly config is not sealed to the snapshot");
  }
  return snapshot.agentConfig;
}

function blockOccurrenceKey(blockId: string, promptOrder: number): string {
  return `${blockId.length}:${blockId}:${promptOrder}`;
}

interface CognitionPhaseRefsV1 {
  readonly workPolicy: readonly CognitionLoomBlockRefV1[];
  readonly workspaceUsage: readonly CognitionLoomBlockRefV1[];
  readonly completionCriteria: readonly CognitionLoomBlockRefV1[];
  readonly renderPolicy: readonly CognitionLoomBlockRefV1[];
  readonly excludedBlockOccurrences: ReadonlySet<string>;
}

function cognitionPhaseRefs(
  snapshot: GenerationAssemblySnapshotV1,
  parsedConfig?: AgentConfigV2,
  customPhasePlan?: AgentRuntimePhaseCompileResultV1,
): CognitionPhaseRefsV1 {
  const source = snapshot.agentCognition.cognitionSource;
  const loomPolicy = loomPolicyForSnapshot(snapshot, parsedConfig);
  const sourceBlocks = new Map(source?.blocks.map((block) => [block.promptOrder, block] as const) ?? []);
  const destPins = new Map<string, string>();
  for (const bucket of ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"] as const) {
    for (const entry of loomPolicy[bucket]) {
      const destKey = `${LOOM_BUCKET_DESTINATION[bucket]}:${blockOccurrenceKey(entry.source.blockId, entry.source.promptOrder)}`;
      const pin = `${entry.source.presetRevision}:${entry.source.blockRevision}`;
      const previous = destPins.get(destKey);
      if (previous !== undefined && previous !== pin) {
        throw new AssemblyPlanValidationError(
          "invalid_input",
          `${bucket}.${entry.id} conflicts with another ${LOOM_BUCKET_DESTINATION[bucket]} pin for ${entry.source.blockId}`,
        );
      }
      destPins.set(destKey, pin);
    }
  }
  const refsForBucket = (bucket: LoomPolicyBucketV1): CognitionLoomBlockRefV1[] => {
    const refs: CognitionLoomBlockRefV1[] = [];
    for (const entry of loomPolicy[bucket]) {
      const sourceBlock = sourceBlocks.get(entry.source.promptOrder);
      const snapshotBlock = snapshot.blocks[entry.source.promptOrder];
      if (snapshotBlock?.marker === "category") {
        throw new AssemblyPlanValidationError("invalid_input", `${bucket}.${entry.id} cannot use a category marker as a Loom source`);
      }
      const exact = source !== null
        && source !== undefined
        && sourceBlock !== undefined
        && sourceBlock.blockId === entry.source.blockId
        && snapshotBlock !== undefined
        && snapshotBlock.id === entry.source.blockId
        && source.presetRevision === entry.source.presetRevision
        && sourceBlock.revision === entry.source.blockRevision
        && String(snapshotBlock.revision) === String(sourceBlock.revision);
      if (!exact) {
        if (entry.required) {
          throw new AssemblyPlanValidationError(
            "invalid_input",
            `${bucket}.${entry.id} is not bound to the frozen Loom block occurrence`,
          );
        }
        continue;
      }
      refs.push({
        blockId: entry.source.blockId,
        expectedPresetRevision: entry.source.presetRevision,
        expectedBlockRevision: entry.source.blockRevision,
        promptOrder: entry.source.promptOrder,
      });
    }
    return refs;
  };
  const workPolicy = refsForBucket("workPolicy");
  const workspaceUsage = refsForBucket("workspaceUsage");
  const completionCriteria = refsForBucket("completionCriteria");
  const renderPolicy = refsForBucket("renderPolicy");
  const customInstructions: CognitionLoomBlockRefV1[] = [];
  for (const phase of customPhasePlan?.phases ?? []) {
    const phaseSources = [
      ...phase.instructionRefs,
      ...phase.childInstructionSubsets.flatMap((subset) => subset.instructionRefs),
    ];
    for (const ref of phaseSources) {
      const sourceBlock = sourceBlocks.get(ref.promptOrder);
      const snapshotBlock = snapshot.blocks[ref.promptOrder];
      if (snapshotBlock?.marker === "category") {
        throw new AssemblyPlanValidationError("invalid_input", `customPhases.${phase.id}.${ref.blockId} cannot use a category marker as a Loom source`);
      }
      if (
        !source
        || !sourceBlock
        || sourceBlock.blockId !== ref.blockId
        || !snapshotBlock
        || snapshotBlock.id !== ref.blockId
        || source.presetRevision !== ref.presetRevision
        || sourceBlock.revision !== ref.blockRevision
        || String(snapshotBlock.revision) !== String(sourceBlock.revision)
      ) {
        throw new AssemblyPlanValidationError(
          "invalid_input",
          `customPhases.${phase.id}.${ref.blockId} at prompt order ${ref.promptOrder} is not bound to the frozen Loom block occurrence`,
        );
      }
      customInstructions.push({
        blockId: ref.blockId,
        expectedPresetRevision: ref.presetRevision,
        expectedBlockRevision: ref.blockRevision,
        promptOrder: ref.promptOrder,
      });
    }
  }
  const all = [...workPolicy, ...workspaceUsage, ...completionCriteria, ...renderPolicy, ...customInstructions];
  if (all.length === 0) {
    return { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [], excludedBlockOccurrences: new Set() };
  }
  const normalize = (
    refs: readonly CognitionLoomBlockRefV1[],
    path: string,
    preserveDuplicates = false,
  ): CognitionLoomBlockRefV1[] => {
    const seen = new Map<string, CognitionLoomBlockRefV1>();
    const retained: CognitionLoomBlockRefV1[] = [];
    for (const ref of refs) {
      const occurrenceKey = blockOccurrenceKey(ref.blockId, ref.promptOrder);
      const previous = seen.get(occurrenceKey);
      if (previous && (
        previous.expectedPresetRevision !== ref.expectedPresetRevision
        || previous.expectedBlockRevision !== ref.expectedBlockRevision
      )) {
        throw new AssemblyPlanValidationError("invalid_input", `${path}.${ref.blockId}@${ref.promptOrder} has conflicting source revisions`);
      }
      const sourceBlock = sourceBlocks.get(ref.promptOrder);
      const snapshotBlock = snapshot.blocks[ref.promptOrder];
      if (!source || !sourceBlock || sourceBlock.blockId !== ref.blockId || !snapshotBlock || snapshotBlock.id !== ref.blockId) {
        throw new AssemblyPlanValidationError("invalid_input", `${path}.${ref.blockId}@${ref.promptOrder} is not in the frozen source`);
      }
      if (snapshotBlock.marker === "category") {
        throw new AssemblyPlanValidationError("invalid_input", `${path}.${ref.blockId}@${ref.promptOrder} cannot use a category marker as a Loom source`);
      }
      if (
        source.presetRevision !== ref.expectedPresetRevision
        || sourceBlock.revision !== ref.expectedBlockRevision
        || String(snapshotBlock.revision) !== String(sourceBlock.revision)
      ) {
        throw new AssemblyPlanValidationError("invalid_input", `${path}.${ref.blockId}@${ref.promptOrder} source revision mismatch`);
      }
      if (!previous) seen.set(occurrenceKey, ref);
      if (preserveDuplicates || !previous) retained.push(ref);
    }
    return retained.sort((left, right) => left.promptOrder - right.promptOrder || compareUtf8(left.blockId, right.blockId));
  };
  const normalizedWork = normalize(workPolicy, "workPolicy", true);
  const normalizedUsage = normalize(workspaceUsage, "workspaceUsage", true);
  const normalizedCompletion = normalize(completionCriteria, "completionCriteria", true);
  const normalizedRender = normalize(renderPolicy, "renderPolicy", true);
  const normalizedCustom = normalize(customInstructions, "customPhases");
  const excludedBlockOccurrences = new Set([
    ...normalizedWork,
    ...normalizedUsage,
    ...normalizedCompletion,
    ...normalizedRender,
    ...normalizedCustom,
  ].map((ref) => blockOccurrenceKey(ref.blockId, ref.promptOrder)));
  return {
    workPolicy: normalizedWork,
    workspaceUsage: normalizedUsage,
    completionCriteria: normalizedCompletion,
    renderPolicy: normalizedRender,
    excludedBlockOccurrences,
  };
}
interface CognitionBlockAdmissionV1 {
  readonly excludedBlockOccurrences: ReadonlySet<string>;
  readonly ignoredBlockOccurrences: ReadonlySet<string>;
}

function cognitionBlockAdmission(
  loomPolicy: LoomPolicyBucketsV1,
  parsedConfig: AgentConfigV2 | undefined,
  phaseRefs: CognitionPhaseRefsV1,
): CognitionBlockAdmissionV1 {
  const authoredBlockOccurrences = new Set<string>();
  for (const bucket of ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"] as const) {
    for (const entry of loomPolicy[bucket]) authoredBlockOccurrences.add(blockOccurrenceKey(entry.source.blockId, entry.source.promptOrder));
  }
  for (const phase of parsedConfig?.runtimePolicy?.phases ?? []) {
    for (const ref of phase.instructionRefs) authoredBlockOccurrences.add(blockOccurrenceKey(ref.blockId, ref.promptOrder));
    for (const subset of phase.childInstructionSubsets) {
      for (const ref of subset.instructionRefs) authoredBlockOccurrences.add(blockOccurrenceKey(ref.blockId, ref.promptOrder));
    }
  }
  const ignoredBlockOccurrences = new Set(
    [...authoredBlockOccurrences].filter((occurrence) => !phaseRefs.excludedBlockOccurrences.has(occurrence)),
  );
  return {
    excludedBlockOccurrences: new Set([...phaseRefs.excludedBlockOccurrences, ...authoredBlockOccurrences]),
    ignoredBlockOccurrences,
  };
}
const EMPTY_LOOM_POLICY: LoomPolicyBucketsV1 = Object.freeze({
  version: 1,
  workPolicy: Object.freeze([]),
  workspaceUsage: Object.freeze([]),
  completionCriteria: Object.freeze([]),
  renderPolicy: Object.freeze([]),
});

function loomPolicyForSnapshot(
  snapshot: GenerationAssemblySnapshotV1,
  parsedConfig: AgentConfigV2 | undefined,
): LoomPolicyBucketsV1 {
  const snapshotPolicy = snapshot.agentCognition.loomPolicy;
  if (snapshotPolicy) return snapshotPolicy;
  const source = snapshot.agentCognition.cognitionSource;
  if (!source) return EMPTY_LOOM_POLICY;
  const config = parsedConfig as unknown as Record<string, unknown> | undefined;
  const runtimePolicy = config?.runtimePolicy;
  const runtimeLoomPolicy = runtimePolicy && typeof runtimePolicy === "object" && !Array.isArray(runtimePolicy)
    ? (runtimePolicy as Record<string, unknown>).loomPolicy
    : undefined;
  if (runtimeLoomPolicy === undefined) return EMPTY_LOOM_POLICY;
  return normalizeLoomPolicyBucketsV1(runtimeLoomPolicy, source);
}

function loomBlocksForPolicy(
  policy: LoomPolicyBucketsV1,
  blocks: readonly SnapshotBlockV1[],
  cognitionSource: CognitionSourceSnapshotV1 | null,
  customPhasePlan?: AgentRuntimePhaseCompileResultV1,
): readonly LoomPromptInspectionBlockV1[] {
  const sourceByPromptOrder = new Map(cognitionSource?.blocks.map((block) => [block.promptOrder, block] as const) ?? []);
  const exactBlock = (source: LoomPolicySourceV1): SnapshotBlockV1 | null => {
    if (!cognitionSource || cognitionSource.presetRevision !== source.presetRevision) return null;
    const frozenSource = sourceByPromptOrder.get(source.promptOrder);
    const block = blocks[source.promptOrder];
    if (!frozenSource
      || frozenSource.blockId !== source.blockId
      || !block
      || block.id !== source.blockId
      || frozenSource.revision !== source.blockRevision
      || String(block.revision) !== String(frozenSource.revision)) return null;
    return block;
  };
  const seen = new Set<string>();
  const result: LoomPromptInspectionBlockV1[] = [];
  for (const bucket of ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"] as const) {
    for (const entry of policy[bucket]) {
      const key = `${entry.source.blockId}\u0000${entry.source.presetRevision}\u0000${entry.source.blockRevision}\u0000${entry.source.promptOrder}`;
      if (seen.has(key)) continue;
      const block = exactBlock(entry.source);
      if (!block) continue;
      seen.add(key);
      result.push(Object.freeze({ source: entry.source, content: block.content }));
    }
  }
  for (const phase of customPhasePlan?.phases ?? []) {
    const phaseSources = [
      ...phase.instructionRefs,
      ...phase.childInstructionSubsets.flatMap((subset) => subset.instructionRefs),
    ];
    for (const source of phaseSources) {
      const key = `${source.blockId}\u0000${source.presetRevision}\u0000${source.blockRevision}\u0000${source.promptOrder}`;
      if (seen.has(key)) continue;
      const block = exactBlock(source);
      if (!block) continue;
      seen.add(key);
      result.push(Object.freeze({ source, content: block.content }));
    }
  }
  return Object.freeze(result);
}


type IntrinsicConfig = AgentConfigV2;
type IntrinsicProfile = AgentConfigV2["profiles"][number];
type ParsedIntrinsicConfig = AgentConfigV2;

function parserConfig(value: unknown): ParsedIntrinsicConfig | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return parseAgentConfigV2(value);
  } catch {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly config must be a closed AgentConfig V2");
  }
}

function profileOutputLimitsFor(
  snapshot: GenerationAssemblySnapshotV1,
  config: ParsedIntrinsicConfig | undefined,
): readonly AssemblyProfileOutputLimitV1[] {
  const hostTokenCeiling = Math.max(
    1,
    Math.ceil(Math.min(snapshot.limits.maxOutputBytes, snapshot.limits.maxOperationBytes) / 4),
  );
  return frozen((config?.profiles ?? []).map((profile) => {
    const authoredOutputTokens = typeof profile.maxOutputTokens === "number" && Number.isFinite(profile.maxOutputTokens)
      ? Math.max(1, Math.floor(profile.maxOutputTokens))
      : Math.max(1, Math.floor(snapshot.limits.maxOperationBytes / 4));
    return frozen({
      profileId: profile.id,
      maxOutputTokens: Math.min(authoredOutputTokens, hostTokenCeiling),
    });
  }));
}

function parseBlocks(
  snapshot: GenerationAssemblySnapshotV1,
  explicitConfig: unknown,
  blocks: readonly SnapshotBlockV1[] = snapshot.blocks,
  excludedBlockOccurrences: ReadonlySet<string> = new Set(),
): InternalBlockPlan[] {
  const selectedBlocks = blocks.map((block, index) => ({ block, index })).filter(({ block, index }) => !excludedBlockOccurrences.has(blockOccurrenceKey(block.id, index)));
  if (selectedBlocks.length > snapshot.limits.maxPromptBlocks) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Prompt block limit exceeded");
  }
  const config = parserConfig(configFor(snapshot, explicitConfig));
  let preflight: ReturnType<typeof preflightAgentIntrinsics> | undefined;
  if (config) {
    try {
      preflight = preflightAgentIntrinsics(
        selectedBlocks.map(({ block }) => ({
          id: block.id,
          content: block.content,
          role: block.role,
          enabled: block.enabled,
          active: true,
        })),
        config as unknown as IntrinsicConfig,
      );
    } catch (error) {
      if (error instanceof AgentIntrinsicValidationError) {
        const code: AssemblyPlanFailureCode =
          error.reasonCode === "forward_reference"
            ? "out_of_order_result_reference"
            : error.reasonCode === "missing_reference"
              ? "missing_result_producer"
              : error.reasonCode === "duplicate_producer"
                ? "duplicate_result_producer"
                : "invalid_intrinsic";
        throw new AssemblyPlanValidationError(code, `Invalid agent intrinsic: ${error.reasonCode}`, error.blockIndex, error.blockId);
      }
      throw error;
    }
    if (preflight.executableIntrinsics.length > config.maxInvocations) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Agent invocation limit exceeded");
    }
    if (config.agentsEnabled !== true && preflight.executableIntrinsics.length > 0) {
      throw new AssemblyPlanValidationError("requires_response_mode", "Agentic assembly requires an enabled AgentConfig V2");
    }
  }
  const parsed: InternalBlockPlan[] = [];
  for (let selectedIndex = 0; selectedIndex < selectedBlocks.length; selectedIndex += 1) {
    const selected = selectedBlocks[selectedIndex]!;
    const block = selected.block;
    const index = selected.index;
    if (!block.enabled) {
      parsed.push({ block, blockIndex: index, references: [], child: null });
      continue;
    }
    const references = scanReferences(block.content, block, index);
    const child = parseChildOpening(block, index);
    const invocation = preflight?.blocks[selectedIndex]?.intrinsic;
    if (child && references.length > 0) failForBlock("nested_result_reference", "A child block cannot also consume a result", block, index);
    if (references.length > 0 && block.role !== "user") failForBlock("invalid_input", "Result references require user blocks", block, index);
    if (child && !config) {
      failForBlock("invalid_intrinsic", "Normalized agent config is required for child assembly", block, index);
    }
    if (child && !invocation) {
      failForBlock("invalid_intrinsic", "Intrinsic did not produce a child invocation", block, index);
    }
    if (invocation && !child) {
      failForBlock("invalid_intrinsic", "Intrinsic parser mismatch", block, index);
    }
    if (child && invocation) {
      parsed.push({
        block,
        blockIndex: index,
        references,
        child: {
          ...child,
          resultName: child.resultName ?? invocation.resultName ?? null,
          task: invocation.taskTemplate,
          toolIds: [...invocation.toolIds],
          failurePolicy: invocation.profile.failurePolicy,
          stream: invocation.stream,
        },
      });
      continue;
    }
    parsed.push({ block, blockIndex: index, references, child: null });
  }
  return parsed;
}

function makeLiteral(text: string, maxBytes: number, block: SnapshotBlockV1, blockIndex: number): AssemblyLiteralSegmentV1 | null {
  if (text.length === 0) return null;
  const byteCount = bytes(text);
  if (byteCount > maxBytes) failForBlock("limit_exceeded", "Literal segment exceeds operation limit", block, blockIndex);
  return frozen({ kind: "literal", text, bytes: byteCount });
}
function blockSegments(
  block: SnapshotBlockV1,
  blockIndex: number,
  references: readonly ParsedReference[],
  slotByName: ReadonlyMap<string, AssemblyResultSlotV1>,
  maxBytes: number,
  maxSegments: number,
): AssemblyMessageSegmentV1[] {
  if (references.length > maxSegments) {
    failForBlock("limit_exceeded", "Provider message segment limit exceeded", block, blockIndex);
  }
  const segments: AssemblyMessageSegmentV1[] = [];
  let cursor = 0;
  for (const reference of references) {
    const literal = makeLiteral(block.content.slice(cursor, reference.start), maxBytes, block, blockIndex);
    if (literal) segments.push(literal);
    const slot = slotByName.get(reference.resultName);
    if (!slot) failForBlock("missing_result_producer", "Missing result producer", block, blockIndex);
    segments.push(frozen({ kind: "result_slot", slotIndex: slot.slotIndex, resultName: slot.resultName, maxBytes: slot.maxBytes, bytes: 0 }));
    cursor = reference.end;
  }
  const tail = makeLiteral(block.content.slice(cursor), maxBytes, block, blockIndex);
  if (tail) segments.push(tail);
  if (segments.length > maxSegments) {
    failForBlock("limit_exceeded", "Provider message segment limit exceeded", block, blockIndex);
  }
  return segments;
}
function phasePolicyMessages(
  blocks: readonly SnapshotBlockV1[],
  refs: readonly CognitionLoomBlockRefV1[],
  limits: PreparationLimitsV1,
  bucket: LoomPolicyBucketV1,
  policy: LoomPolicyBucketsV1,
): readonly AssemblyCompiledPolicyProviderMessageV1[] {
  const byPromptOrder = blocks.map((block, index) => ({ block, index }));
  const policyBySource = new Map<string, LoomPolicyEntryV1[]>();
  for (const entry of policy[bucket]) {
    const key = `${blockOccurrenceKey(entry.source.blockId, entry.source.promptOrder)}:${entry.source.presetRevision}:${entry.source.blockRevision}`;
    const entries = policyBySource.get(key) ?? [];
    entries.push(entry);
    policyBySource.set(key, entries);
  }
  const consumedBySource = new Map<string, number>();
  const messages: AssemblyCompiledPolicyProviderMessageV1[] = [];
  for (const [order, ref] of refs.entries()) {
    const entry = byPromptOrder[ref.promptOrder];
    if (!entry || entry.block.id !== ref.blockId) throw new AssemblyPlanValidationError("invalid_input", `Loom policy block occurrence ${ref.blockId}@${ref.promptOrder} is missing`);
    const sourceKey = `${blockOccurrenceKey(ref.blockId, ref.promptOrder)}:${ref.expectedPresetRevision}:${ref.expectedBlockRevision}`;
    const sourceEntries = policyBySource.get(sourceKey);
    const sourceEntryIndex = consumedBySource.get(sourceKey) ?? 0;
    const sourceEntry = sourceEntries?.[sourceEntryIndex];
    if (!sourceEntry) {
      throw new AssemblyPlanValidationError("invalid_input", `Loom policy provenance is missing for ${ref.blockId}`);
    }
    consumedBySource.set(sourceKey, sourceEntryIndex + 1);
    if (!entry.block.enabled) throw new AssemblyPlanValidationError("invalid_input", `Loom policy block ${ref.blockId} is disabled`);
    if (agentMarkersPresent(entry.block.content)) throw new AssemblyPlanValidationError("requires_response_mode", "Loom policy blocks cannot contain agent result references");
    const literal = makeLiteral(entry.block.content, limits.maxOperationBytes, entry.block, entry.index)
      ?? frozen({ kind: "literal" as const, text: "", bytes: 0 });
    const message = messageForBlock(entry.block, entry.index, [literal], "cognition", order);
    messages.push(frozen({
      ...message,
      blockIndex: entry.index,
      provenance: {
        kind: "cognition" as const,
        sourceId: message.provenance.sourceId,
        sourceRevision: message.provenance.sourceRevision,
        sourceIndex: message.provenance.sourceIndex,
        loom: {
          entryId: sourceEntry.id,
          bucket,
          destination: sourceEntry.destination,
          checkpoint: sourceEntry.checkpoint,
          source: sourceEntry.source,
          ...(sourceEntry.condition === undefined ? {} : { condition: sourceEntry.condition }),
          effectiveText: entry.block.content,
        },
      },
    }));
  }
  return frozen(messages);
}

function isCompiledPolicyMessage(
  message: AssemblyProviderMessageV1,
): message is AssemblyCompiledPolicyProviderMessageV1 {
  return message.provenance.kind === "cognition"
    && message.provenance.loom !== undefined
    && Number.isSafeInteger(message.blockIndex)
    && (message.blockIndex ?? -1) >= 0;
}

/**
 * Project one frozen Loom bucket through the authoritative runtime checkpoint
 * inspection. Compilation retains every authored entry; only this projection
 * may replace or omit provider-visible policy text.
 */
export function selectEffectiveLoomPolicyMessagesV1(
  messages: readonly AssemblyProviderMessageV1[],
  inspectionValue: unknown,
  bucket: LoomPolicyBucketV1,
  trustedLimits: PreparationLimitsV1,
): readonly AssemblyProviderMessageV1[] {
  if (!["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"].includes(bucket)) {
    throw new AssemblyPlanValidationError("invalid_input", "Unknown Loom policy bucket");
  }
  const limits = assertPreparationLimits(trustedLimits);
  const inspection: LoomPromptInspectionV1 = parseLoomPromptInspectionV1(inspectionValue);
  if (inspection.surface !== "WORK") {
    throw new AssemblyPlanValidationError("invalid_input", "Provider policy selection requires a WORK inspection");
  }
  const bucketItems = inspection.items.filter((item) => item.bucket === bucket);
  if (messages.length > bucketItems.length) {
    throw new AssemblyPlanValidationError("invalid_input", `Loom ${bucket} messages exceed the inspected policy`);
  }
  const itemById = new Map(bucketItems.map((item) => [item.entryId, item] as const));
  const messageById = new Map<string, AssemblyCompiledPolicyProviderMessageV1>();
  for (const message of messages) {
    if (!isCompiledPolicyMessage(message)) {
      throw new AssemblyPlanValidationError("invalid_input", `Loom ${bucket} message provenance is invalid`);
    }
    const loom = message.provenance.loom;
    if (loom.bucket !== bucket || messageById.has(loom.entryId)) {
      throw new AssemblyPlanValidationError("invalid_input", `Loom ${bucket} message provenance is invalid`);
    }
    const item = itemById.get(loom.entryId);
    if (
      !item
      || loom.destination !== item.destination
      || loom.checkpoint !== item.checkpoint
      || canonical(loom.source) !== canonical(item.source)
      || canonical(loom.condition) !== canonical(item.condition)
    ) {
      throw new AssemblyPlanValidationError("invalid_input", `Loom ${bucket} message provenance does not match inspection`);
    }
    if (
      message.segments.length !== 1
      || message.segments[0]?.kind !== "literal"
      || message.segments[0].text !== loom.effectiveText
    ) {
      throw new AssemblyPlanValidationError("invalid_input", `Loom ${bucket} source message is not a sealed literal`);
    }
    messageById.set(loom.entryId, message);
  }
  const included = bucketItems
    .filter((item) => item.outcome.status === "included")
    .sort((left, right) => {
      const leftIndex = left.outcome.status === "included" ? left.outcome.effectiveIndex : -1;
      const rightIndex = right.outcome.status === "included" ? right.outcome.effectiveIndex : -1;
      return leftIndex - rightIndex;
    });
  const selected: AssemblyCompiledPolicyProviderMessageV1[] = [];
  let totalBytes = 0;
  for (const item of bucketItems) {
    if (item.outcome.status === "rejected") {
      throw new AssemblyPlanValidationError("invalid_input", `Loom ${bucket} entry ${item.entryId} was rejected`);
    }
  }
  for (const item of included) {
    const message = messageById.get(item.entryId);
    if (!message || item.effectiveText === null) {
      throw new AssemblyPlanValidationError("invalid_input", `Loom ${bucket} included entry is unavailable`);
    }
    const textBytes = bytes(item.effectiveText);
    if (textBytes > limits.maxOperationBytes) {
      throw new AssemblyPlanValidationError("limit_exceeded", `Loom ${bucket} entry exceeds the operation limit`);
    }
    totalBytes += textBytes;
    if (totalBytes > limits.maxInputBytes) {
      throw new AssemblyPlanValidationError("limit_exceeded", `Loom ${bucket} entries exceed the input limit`);
    }
    const loom = message.provenance.loom!;
    selected.push(frozen({
      ...message,
      segments: frozen([frozen({ kind: "literal" as const, text: item.effectiveText, bytes: textBytes })]),
      provenance: frozen({
        ...message.provenance,
        loom: frozen({ ...loom, effectiveText: item.effectiveText }),
      }),
    }));
  }
  return frozen(selected);
}

function cognitionPhaseActivationEvidence(
  snapshot: GenerationAssemblySnapshotV1,
  phase: AssemblyCognitionEvidenceV1["phase"],
  section: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy",
  refs: readonly CognitionLoomBlockRefV1[],
  messages: readonly AssemblyProviderMessageV1[],
): readonly AssemblyCognitionEvidenceV1[] {
  const source = snapshot.agentCognition.cognitionSource;
  if (!source) return frozen([]);
  const sourceByPromptOrder = new Map(source.blocks.map((block) => [block.promptOrder, block] as const));
  return frozen(refs.map((ref, order): AssemblyCognitionEvidenceV1 => {
    const sourceBlock = sourceByPromptOrder.get(ref.promptOrder);
    const message = messages[order];
    const messageSource = message?.provenance?.loom?.source;
    if (!sourceBlock || sourceBlock.blockId !== ref.blockId || !message || message.blockId !== ref.blockId || !messageSource || messageSource.promptOrder !== ref.promptOrder) throw new AssemblyPlanValidationError("invalid_input", `Cognition evidence source occurrence is missing for ${ref.blockId}@${ref.promptOrder}`);
    const byteCost = message.segments.reduce((total, segment) => total + (segment.kind === "literal" ? bytes(segment.text) : 0), 0);
    const tokenCost = Math.max(1, Math.ceil(byteCost / 4));
    return frozen({
      kind: "cognition_phase",
      phase,
      section,
      blockId: ref.blockId,
      expectedPresetRevision: ref.expectedPresetRevision,
      expectedBlockRevision: ref.expectedBlockRevision,
      actualPresetRevision: source.presetRevision,
      actualBlockRevision: sourceBlock.revision,
      order,
      promptOrder: sourceBlock.promptOrder,
      decision: "selected",
      ruleSourceRevision: `${source.presetRevision}:${sourceBlock.revision}`,
      tokenCost,
      byteCost,
    });
  }));
}
function messageProvenance(
  kind: AssemblyMessageSourceKindV1,
  sourceId: string,
  sourceRevision: string,
  sourceIndex: number,
  databank?: AssemblyDatabankMessageProvenanceV1,
): AssemblyOrdinaryMessageProvenanceV1 {
  if (sourceId.length === 0 || sourceRevision.length === 0 || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly message provenance is invalid");
  }
  return frozen({
    kind,
    sourceId,
    sourceRevision,
    sourceIndex,
    ...(databank ? { databank: frozen({ kind: databank.kind, sources: frozen([...databank.sources]) }) } : {}),
  });
}

function messageForBlock(
  block: SnapshotBlockV1,
  blockIndex: number,
  segments: readonly AssemblyMessageSegmentV1[],
  kind: "block" | "cognition" = "block",
  sourceIndex = blockIndex,
): AssemblyOrdinaryProviderMessageV1 {
  const role = block.role === "user_append" ? "user" : block.role === "assistant_append" ? "assistant" : block.role;
  return frozen({
    role,
    blockIndex,
    blockId: block.id,
    segments: frozen([...segments]),
    contentKind: "segments",
    provenance: messageProvenance(kind, block.id, block.revision, sourceIndex),
  });
}

function messageForHistory(message: SnapshotMessageV1, maxBytes: number, sourceIndex: number): AssemblyProviderMessageV1 {
  const rawText = typeof message.content === "string" ? message.content : "";
  const mediaParts = message.mediaParts ?? [];
  const text = mediaParts.length > 0 ? rawText.replace(/\s*\(attached\)\s*$/u, "") : rawText;
  if (bytes(text) > maxBytes) throw new AssemblyPlanValidationError("limit_exceeded", "Chat message exceeds operation limit");
  const segments: AssemblyMessageSegmentV1[] = [];
  if (text.length > 0 || mediaParts.length === 0) {
    segments.push(frozen({ kind: "literal", text, bytes: bytes(text) }));
  }
  for (const media of mediaParts) segments.push(frozen({ ...media, bytes: 0 }));
  return frozen({
    role: message.is_user ? "user" : "assistant",
    ...(message.name ? { name: message.name } : {}),
    segments: frozen(segments),
    contentKind: "segments",
    provenance: messageProvenance("history", message.id, message.revision, sourceIndex),
  });
}

function messageForWorldInfo(
  content: string,
  role: string | null | undefined,
  maxBytes: number,
  sourceId: string,
  sourceRevision: string,
  sourceIndex: number,
): AssemblyProviderMessageV1 {
  const textBytes = bytes(content);
  if (textBytes > maxBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "World-info content exceeds operation limit");
  }
  return frozen({
    role: roleForWorldInfo(role),
    segments: frozen([frozen({ kind: "literal", text: content, bytes: textBytes })]),
    contentKind: "segments",
    provenance: messageProvenance("world_info", sourceId, sourceRevision, sourceIndex),
  });
}
function messageForDatabank(
  snapshot: GenerationAssemblySnapshotV1,
  sourceIndex: number,
): AssemblyProviderMessageV1 | null {
  const databank = snapshot.databank;
  if (!databank?.enabled) return null;
  const content = databank?.automaticFormatted ?? "";
  const sources = (databank?.provenance ?? [])
    .filter((entry): entry is SnapshotDatabankProvenanceV1 => entry.kind === "automatic")
    .map((entry) => ({
      kind: entry.kind,
      databankId: entry.databankId,
      documentId: entry.documentId,
      documentName: entry.documentName,
      chunkId: entry.chunkId,
      documentContentHash: entry.documentContentHash,
      contentHash: entry.contentHash,
    }));
  if (content.length === 0 || sources.length === 0) return null;
  const sourceRevision = digest({ contentHash: digest(content), sources });
  const textBytes = bytes(content);
  if (textBytes > snapshot.limits.maxOperationBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Databank content exceeds operation limit");
  }
  const databankProvenance: AssemblyDatabankMessageProvenanceV1 = {
    kind: "automatic",
    sources: frozen(sources),
  };
  return frozen({
    role: "system",
    segments: frozen([frozen({ kind: "literal", text: content, bytes: textBytes })]),
    contentKind: "segments",
    provenance: messageProvenance("databank", `databank:${sourceRevision}`, sourceRevision, sourceIndex, databankProvenance),
  });
}


function normalizeInput(
  input: GenerationAssemblySnapshotV1 | CompileAgentAssemblyRequestV1 | { snapshot: GenerationAssemblySnapshotV1; agentConfig?: unknown; requestId?: string },
): { snapshot: GenerationAssemblySnapshotV1; agentConfig?: unknown; requestId?: string } {
  canonical(input, HOST_PREPARATION_LIMITS_V1.maxInputBytes + HOST_PREPARATION_LIMITS_V1.maxOutputBytes);
  if (input && typeof input === "object" && "snapshot" in input) {
    const value = input as { snapshot?: unknown; agentConfig?: unknown; requestId?: unknown };
    if (!value.snapshot || typeof value.snapshot !== "object") throw new AssemblyPlanValidationError("invalid_input", "Missing assembly snapshot");
    return {
      snapshot: value.snapshot as GenerationAssemblySnapshotV1,
      agentConfig: value.agentConfig,
      requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    };
  }
  return { snapshot: input as GenerationAssemblySnapshotV1 };
}

/**
 * Compile snapshot data into a strict, literal/result-slot assembly plan.
 * Macro text uses the same evaluator as Response against snapshot-owned extras.
 */
export async function compileAgentAssemblyPlan(
  input: GenerationAssemblySnapshotV1 | CompileAgentAssemblyRequestV1 | { snapshot: GenerationAssemblySnapshotV1; agentConfig?: unknown; requestId?: string },
): Promise<AssemblyPlanV1> {
  const { snapshot, agentConfig, requestId } = normalizeInput(input);
  validateSnapshotIdentity(snapshot);
  if (snapshot.assemblySurface !== "WORK") {
    throw new AssemblyPlanValidationError("invalid_input", "Strict agent assembly requires the WORK surface");
  }
  if (bytes(snapshot.snapshotId) > 256) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly snapshot identity is too large");
  }
  if (
    snapshot.extensionData !== null
    || snapshot.ambientSpindleData !== null
    || snapshot.availability?.extensionsExcluded !== true
    || snapshot.availability?.ambientSpindleExcluded !== true
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly snapshot contains ambient extension state");
  }
  const limits = assertPreparationLimits(snapshot.limits);
  if (limits !== snapshot.limits) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly limits identity is not stable");
  }
  // Parse the sealed config before cognition or intrinsic traversal. Legacy
  // V1 fields are import-only and never become executable worker authority.
  const parsedConfig = parserConfig(configFor(snapshot, agentConfig));
  const customPhasePlan = compileAgentRuntimePhases(parsedConfig?.runtimePolicy?.phases ?? [], {
    source: snapshot.agentCognition.cognitionSource,
    profileIds: parsedConfig?.profiles.map((profile) => profile.id),
  });
  if (customPhasePlan.status === "failed") {
    throw new AssemblyPlanValidationError("invalid_input", "Required custom WORK phase could not be compiled");
  }
  const loomPolicy = loomPolicyForSnapshot(snapshot, parsedConfig);
  const phaseRefs = cognitionPhaseRefs(snapshot, parsedConfig, customPhasePlan);
  const cognitionAdmission = cognitionBlockAdmission(loomPolicy, parsedConfig, phaseRefs);
  const preparation = await preprocessSnapshot(
    snapshot,
    cognitionAdmission.excludedBlockOccurrences,
    cognitionAdmission.ignoredBlockOccurrences,
  );
  const authoredNonCognitionBlocks = snapshot.blocks
    .map((block, index) => ({ block: projectStructuralBlockAdmission(block, snapshot.participants.structuralBlockValues), index }))
    .filter(({ block, index }) => !cognitionAdmission.excludedBlockOccurrences.has(blockOccurrenceKey(block.id, index)))
    .map(({ block }) => block);
  const macroHandlesDatabank = snapshotUsesDatabankRetrievalMacro(authoredNonCognitionBlocks);
  const parsed = parseBlocks(snapshot, parsedConfig, preparation.blocks, cognitionAdmission.excludedBlockOccurrences);
  const loomBlocks = loomBlocksForPolicy(loomPolicy, preparation.blocks, snapshot.agentCognition.cognitionSource, customPhasePlan);
  const producerByName = new Map<string, { block: SnapshotBlockV1; blockIndex: number; child: ParsedChild }>();
  for (const item of parsed) {
    const name = item.child?.resultName;
    if (!name) continue;
    if (producerByName.has(name)) failForBlock("duplicate_result_producer", "Duplicate result producer", item.block, item.blockIndex);
    producerByName.set(name, { block: item.block, blockIndex: item.blockIndex, child: item.child });
  }
  for (const item of parsed) {
    for (const reference of item.references) {
      const producer = producerByName.get(reference.resultName);
      if (!producer) failForBlock("missing_result_producer", "Missing result producer", item.block, item.blockIndex);
      if (producer.blockIndex >= item.blockIndex) {
        failForBlock(
          producer.blockIndex === item.blockIndex ? "recursive_result_reference" : "out_of_order_result_reference",
          "Result producer must precede its consumer",
          item.block,
          item.blockIndex,
        );
      }
    }
  }
  const children: AssemblyChildDescriptorV1[] = [];
  const slots: AssemblyResultSlotV1[] = [];
  for (const item of parsed) {
    if (!item.child) continue;
    const profile = parsedConfig?.profiles.find(
      (candidate: IntrinsicProfile) => candidate.id === item.child!.profileId,
    );
    const authoredOutputTokens = typeof profile?.maxOutputTokens === "number" && Number.isFinite(profile.maxOutputTokens)
      ? Math.max(1, Math.floor(profile.maxOutputTokens))
      : Math.max(1, Math.floor(snapshot.limits.maxOperationBytes / 4));
    const maxOutputBytes = Math.min(
      snapshot.limits.maxOutputBytes,
      authoredOutputTokens * CHILD_RESULT_BYTES_PER_AUTHORED_TOKEN,
    );
    const maxOutputTokens = Math.min(authoredOutputTokens, Math.max(1, Math.ceil(maxOutputBytes / 4)));
    const taskBytes = bytes(item.child.task);
    if (taskBytes > AGENT_CHILD_TASK_MAX_BYTES) {
      failForBlock(
        "limit_exceeded",
        `Child task exceeds ${AGENT_CHILD_TASK_MAX_BYTES / 1024} KiB UTF-8 limit`,
        item.block,
        item.blockIndex,
      );
    }
    const slotIndex = children.length;
    const resultName = item.child.resultName ?? `child_${slotIndex}`;
    const seal = digest({ slotIndex, blockIndex: item.blockIndex, blockId: item.block.id, resultName });
    const childId = `${snapshot.snapshotId}:child:${slotIndex}`;
    children.push(frozen({
      childId,
      slotIndex,
      traversalIndex: slotIndex,
      blockIndex: item.blockIndex,
      blockId: item.block.id,
      profileId: item.child.profileId,
      resultName,
      task: item.child.task,
      taskBytes,
      maxOutputBytes,
      maxOutputTokens,
      required: item.child.failurePolicy === "required",
      toolIds: frozen([...item.child.toolIds]),
      streamActivity: item.child.stream,
      sourceOffset: item.blockIndex,
      failurePolicy: item.child.failurePolicy,
      producerSeal: seal,
    }));
    slots.push(frozen({
      childId,
      slotIndex,
      resultName,
      producerBlockIndex: item.blockIndex,
      producerBlockId: item.block.id,
      maxBytes: maxOutputBytes,
      seal,
    }));
  }
  const slotByName = new Map<string, AssemblyResultSlotV1>(
    slots.map((slot): [string, AssemblyResultSlotV1] => [slot.resultName, slot]),
  );
  const preHistoryMessages: AssemblyProviderMessageV1[] = [];
  const inHistoryMessages: Array<{ block: SnapshotBlockV1; message: AssemblyProviderMessageV1 }> = [];
  const postHistoryMessages: AssemblyProviderMessageV1[] = [];
  const addBlockMessage = (block: SnapshotBlockV1, message: AssemblyProviderMessageV1): void => {
    if (block.position === "pre_history") preHistoryMessages.push(message);
    else if (block.position === "in_history") inHistoryMessages.push({ block, message });
    else postHistoryMessages.push(message);
  };
  for (const item of parsed) {
    if (!item.block.enabled) continue;
    const child = item.child;
    const explicitWorldMessages = !child && item.block.marker === "world_info_before"
      ? preparation.worldBefore
      : !child && item.block.marker === "world_info_after"
        ? preparation.worldAfter
        : null;
    if (explicitWorldMessages) {
      for (const message of explicitWorldMessages) {
        addBlockMessage(item.block, frozen({ ...message, role: roleForWorldInfo(item.block.role) }));
      }
      continue;
    }
    if (child) {
      const descriptor = children.find((candidate) => candidate.blockIndex === item.blockIndex);
      const slot = descriptor ? slots[descriptor.slotIndex] : undefined;
      if (!descriptor || !slot) failForBlock("invalid_input", "Child result slot is missing", item.block, item.blockIndex);
      addBlockMessage(item.block, messageForBlock(item.block, item.blockIndex, [frozen({ kind: "result_slot", slotIndex: slot.slotIndex, resultName: slot.resultName, maxBytes: slot.maxBytes, bytes: 0 })]));
      continue;
    }
    const segments = blockSegments(
      item.block,
      item.blockIndex,
      item.references,
      slotByName,
      snapshot.limits.maxOperationBytes,
      Math.max(1, snapshot.limits.maxPromptBlocks * 16),
    );
    if (segments.length > 0) addBlockMessage(item.block, messageForBlock(item.block, item.blockIndex, segments));
  }
  const historyMessages = [...preparation.history];
  const historyWithDepth = [...historyMessages];
  for (let index = inHistoryMessages.length - 1; index >= 0; index--) {
    const entry = inHistoryMessages[index]!;
    const depth = Math.max(0, Math.floor(entry.block.depth));
    const insertionIndex = Math.max(0, Math.min(historyMessages.length, historyMessages.length - depth));
    historyWithDepth.splice(insertionIndex, 0, entry.message);
  }
  const automaticDatabankMessage = macroHandlesDatabank
    ? null
    : messageForDatabank(snapshot, preHistoryMessages.length);
  const hasWorldBeforeMarker = parsed.some((item) => item.block.enabled && !item.child && item.block.marker === "world_info_before");
  const hasWorldAfterMarker = parsed.some((item) => item.block.enabled && !item.child && item.block.marker === "world_info_after");
  const providerMessages: AssemblyProviderMessageV1[] = [
    ...preHistoryMessages,
    ...(automaticDatabankMessage ? [automaticDatabankMessage] : []),
    ...historyWithDepth,
    ...postHistoryMessages,
  ];
  const insertMessages = (index: number, messages: readonly AssemblyProviderMessageV1[]): number => {
    if (messages.length === 0) return 0;
    const boundary = Math.max(0, Math.min(index, providerMessages.length));
    providerMessages.splice(boundary, 0, ...messages);
    return messages.length;
  };
  const historyIndexes = (): number[] => providerMessages
    .map((message, index) => message.provenance.kind === "history" ? index : -1)
    .filter((index) => index >= 0);
  let chatIndexes = historyIndexes();
  if (!hasWorldBeforeMarker) {
    insertMessages(chatIndexes[0] ?? 0, preparation.worldBefore);
  }
  chatIndexes = historyIndexes();
  if (!hasWorldAfterMarker) {
    insertMessages(chatIndexes.length > 0 ? chatIndexes[chatIndexes.length - 1]! + 1 : providerMessages.length, preparation.worldAfter);
  }
  chatIndexes = historyIndexes();
  if (chatIndexes.length > 0) {
    insertMessages(chatIndexes[0]!, preparation.worldAnBefore);
    chatIndexes = historyIndexes();
    insertMessages(chatIndexes[0]! + 1, preparation.worldAnAfter);
    chatIndexes = historyIndexes();
    const emStart = chatIndexes[0]!;
    insertMessages(emStart, preparation.worldEmBefore);
    insertMessages(emStart + 1, preparation.worldEmAfter);
  }
  for (const entry of preparation.worldDepth) {
    insertMessages(providerMessages.length - entry.depth, [entry.message]);
  }
  const runtimeSequence = new Set<AssemblyProviderMessageV1>(
    providerMessages.filter((message) => message.provenance.kind === "history"),
  );
  for (const entry of preparation.worldRuntime) {
    chatIndexes = providerMessages
      .map((message, index) => runtimeSequence.has(message) ? index : -1)
      .filter((index) => index >= 0);
    const sequenceLength = chatIndexes.length;
    const spliceStart = entry.direction === "from_start" ? entry.depth : sequenceLength - entry.depth;
    const logicalBoundary = spliceStart < 0
      ? Math.max(sequenceLength + spliceStart, 0)
      : Math.min(spliceStart, sequenceLength);
    const physicalBoundary = logicalBoundary < sequenceLength
      ? chatIndexes[logicalBoundary]!
      : sequenceLength > 0
        ? chatIndexes[sequenceLength - 1]! + 1
        : providerMessages.length - postHistoryMessages.length;
    insertMessages(physicalBoundary, [entry.message]);
    runtimeSequence.add(entry.message);
  }
  const workPolicyMessages = phasePolicyMessages(preparation.blocks, phaseRefs.workPolicy, snapshot.limits, "workPolicy", loomPolicy);
  const workspaceUsageMessages = phasePolicyMessages(preparation.blocks, phaseRefs.workspaceUsage, snapshot.limits, "workspaceUsage", loomPolicy);
  const completionCriteriaMessages = phasePolicyMessages(preparation.blocks, phaseRefs.completionCriteria, snapshot.limits, "completionCriteria", loomPolicy);
  const renderPolicyMessages = phasePolicyMessages(preparation.blocks, phaseRefs.renderPolicy, snapshot.limits, "renderPolicy", loomPolicy);
  const phaseMessages = [...workPolicyMessages, ...workspaceUsageMessages, ...completionCriteriaMessages, ...renderPolicyMessages];
  if (providerMessages.length + phaseMessages.length > snapshot.limits.maxPromptBlocks * 16) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Provider and cognition policy message limit exceeded");
  }
  const seals: AssemblySealV1[] = [];
  let sequence = 0;
  for (const message of providerMessages) {
    for (const segment of message.segments) {
      if (segment.kind !== "result_slot") continue;
      const slot = slots[segment.slotIndex];
      if (!slot) throw new AssemblyPlanValidationError("invalid_input", "Result slot is missing");
      const isProducer = message.blockIndex === slot.producerBlockIndex && message.blockId === slot.producerBlockId;
      seals.push(frozen({
        kind: isProducer ? "producer" : "consumer",
        resultName: slot.resultName,
        slotIndex: slot.slotIndex,
        blockIndex: message.blockIndex ?? -1,
        blockId: message.blockId ?? "",
        sequence: sequence++,
      }));
    }
  }
  let literalInputBytes = 0;
  let reservedResultBytes = 0;
  for (const message of [...providerMessages, ...phaseMessages]) {
    for (const segment of message.segments) {
      if (segment.kind === "literal") literalInputBytes += segment.bytes;
      else if (segment.kind === "result_slot") reservedResultBytes += segment.maxBytes;
    }
  }
  if (literalInputBytes > snapshot.limits.maxInputBytes || literalInputBytes + reservedResultBytes > snapshot.limits.maxInputBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Assembly provider input exceeds the host input limit");
  }
  if (reservedResultBytes > snapshot.limits.maxCumulativeExpansionBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Assembly child expansion exceeds the cumulative limit");
  }
  if (reservedResultBytes > snapshot.limits.maxOutputBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Assembly child output exceeds the output limit");
  }
  const cognitionEvidence = frozen([
    ...cognitionPhaseActivationEvidence(snapshot, "WORK", "workPolicy", phaseRefs.workPolicy, workPolicyMessages),
    ...cognitionPhaseActivationEvidence(snapshot, "WORK", "workspaceUsage", phaseRefs.workspaceUsage, workspaceUsageMessages),
    ...cognitionPhaseActivationEvidence(snapshot, "PREPARE_COMMIT", "completionCriteria", phaseRefs.completionCriteria, completionCriteriaMessages),
    ...cognitionPhaseActivationEvidence(snapshot, "RENDER", "renderPolicy", phaseRefs.renderPolicy, renderPolicyMessages),
  ]);
  const privateEvidence: AssemblyPrivateEvidenceV1 = frozen({
    activation: frozen([
      ...parsed.map((item) => frozen({
        blockIndex: item.blockIndex,
        blockId: item.block.id,
        hasChild: !!item.child,
        referenceCount: item.references.length,
      })),
      ...preparation.worldInfo.evidence,
      ...preparation.macroEvidence,
      ...preparation.regexEvidence,
    ]),
    cognition: cognitionEvidence,
    token: frozen({ snapshotId: snapshot.snapshotId, inputBytes: bytes(canonical(snapshot)), providerMessageCount: providerMessages.length }),
    inputRevisionDigest: snapshot.inputRevisionSet.digest,
  });
  const activationEvidence: AssemblyActivationEvidenceV1[] = children.map((child) => frozen({
    kind: "activation" as const,
    profileId: child.profileId,
    authorized: true,
    tokenCost: Math.max(1, Math.ceil(child.taskBytes / 4)),
  }));
  const tokenEvidence: AssemblyTokenEvidenceV1[] = children.map((child) => frozen({
    kind: "token" as const,
    profileId: child.profileId,
    estimatedInputTokens: Math.max(1, Math.ceil(child.taskBytes / 4)),
    estimatedOutputTokens: Math.max(1, Math.ceil(child.maxOutputBytes / 4)),
  }));
  const profileOutputLimits = profileOutputLimitsFor(snapshot, parserConfig(configFor(snapshot, agentConfig)));
  const plan = frozen({
    version: 1 as const,
    assemblySurface: "WORK" as const,
    operation: AGENT_ASSEMBLY_OPERATION,
    requestId: (requestId ?? snapshot.generationId) || snapshot.snapshotId,
    limits: snapshot.limits,
    messages: frozen(providerMessages),
    providerMessages: frozen(providerMessages),
    workPolicyMessages,
    workspaceUsageMessages,
    completionCriteriaMessages,
    renderPolicyMessages,
    customPhasePlan,
    loomPolicy,
    loomBlocks,
    children: frozen(children),
    childDescriptors: frozen(children),
    resultSlots: frozen(slots),
    activationEvidence: frozen(activationEvidence),
    tokenEvidence: frozen(tokenEvidence),
    profileOutputLimits,
    inputRevisions: snapshot.inputRevisionSet,
    inputRevisionSet: snapshot.inputRevisionSet,
    deltas: frozen(preparation.deltas),
    seals: frozen(seals),
    privateEvidence,
    deferredDeltas: frozen(preparation.deltas),
    snapshotId: snapshot.snapshotId,
  });
  validateAssemblyPlanV1(plan, snapshot.limits);
  return plan;
}

/**
 * Validate a plan received from an isolate before any child dispatch. This is
 * intentionally stricter than TypeScript structural typing because the plan
 * is untrusted bytes at this boundary.
 */
function isValidDatabankMessageProvenance(value: unknown): value is AssemblyDatabankMessageProvenanceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["kind", "sources"].includes(key))) return false;
  if (record.kind !== "automatic" && record.kind !== "mention") return false;
  if (!Array.isArray(record.sources) || record.sources.length > HOST_PREPARATION_LIMITS_V1.maxPromptBlocks * 16) return false;
  for (const source of record.sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return false;
    const entry = source as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => !["kind", "databankId", "documentId", "documentName", "chunkId", "documentContentHash", "contentHash"].includes(key))
      || entry.kind !== record.kind
      || typeof entry.databankId !== "string"
      || entry.databankId.length === 0
      || bytes(entry.databankId) > 256
      || typeof entry.documentId !== "string"
      || entry.documentId.length === 0
      || bytes(entry.documentId) > 256
      || typeof entry.documentName !== "string"
      || entry.documentName.length === 0
      || bytes(entry.documentName) > 256
      || (entry.chunkId !== null && (typeof entry.chunkId !== "string" || bytes(entry.chunkId) > 256))
      || (entry.documentContentHash !== null && (typeof entry.documentContentHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.documentContentHash)))
      || typeof entry.contentHash !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.contentHash)
    ) return false;
  }
  return true;
}

function isValidAssemblyMessageProvenance(value: unknown): value is AssemblyMessageProvenanceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["kind", "sourceId", "sourceRevision", "sourceIndex", "loom", "databank"].includes(key))) return false;
  if (
    (candidate.kind !== "block"
      && candidate.kind !== "history"
      && candidate.kind !== "world_info"
      && candidate.kind !== "cognition"
      && candidate.kind !== "databank")
    || typeof candidate.sourceId !== "string"
    || candidate.sourceId.length === 0
    || bytes(candidate.sourceId) > 256
    || typeof candidate.sourceRevision !== "string"
    || candidate.sourceRevision.length === 0
    || bytes(candidate.sourceRevision) > 256
    || !Number.isSafeInteger(candidate.sourceIndex)
    || (candidate.sourceIndex as number) < 0
  ) return false;
  const databank = candidate.databank;
  if (candidate.kind === "databank" && !isValidDatabankMessageProvenance(databank)) return false;
  if (candidate.kind !== "databank" && databank !== undefined) return false;
  const loom = candidate.loom;
  if (loom === undefined) return true;
  if (!loom || typeof loom !== "object" || Array.isArray(loom)) return false;
  const record = loom as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["entryId", "bucket", "destination", "checkpoint", "source", "condition", "effectiveText"].includes(key))) return false;
  const source = record.source;
  const condition = record.condition;
  if (
    typeof record.entryId !== "string"
    || record.entryId.length === 0
    || !["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"].includes(String(record.bucket))
    || !["root_work", "completion_handoff", "render"].includes(String(record.destination))
    || !["ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER"].includes(String(record.checkpoint))
    || typeof record.effectiveText !== "string"
    || bytes(record.effectiveText) > HOST_PREPARATION_LIMITS_V1.maxOperationBytes
    || !source || typeof source !== "object" || Array.isArray(source)
    || (condition !== undefined && (!condition || typeof condition !== "object" || Array.isArray(condition)))
  ) return false;
  const sourceRecord = source as Record<string, unknown>;
  if (
    sourceRecord.kind !== "loom_block"
    || typeof sourceRecord.blockId !== "string"
    || !Number.isSafeInteger(sourceRecord.presetRevision)
    || (sourceRecord.presetRevision as number) < 0
    || !Number.isSafeInteger(sourceRecord.blockRevision)
    || (sourceRecord.blockRevision as number) < 0
    || !Number.isSafeInteger(sourceRecord.promptOrder)
    || (sourceRecord.promptOrder as number) < 0
  ) return false;
  if (condition !== undefined) {
    try {
      canonical(condition, HOST_PREPARATION_LIMITS_V1.maxOperationBytes);
    } catch {
      return false;
    }
  }
  return true;
}

export function validateAssemblyPlanV1(plan: unknown, trustedLimits: PreparationLimitsV1): asserts plan is AssemblyPlanV1 {
  const trusted = assertPreparationLimits(trustedLimits);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new AssemblyPlanValidationError("invalid_input", "Assembly plan is not an object");
  canonical(plan, HOST_PREPARATION_LIMITS_V1.maxInputBytes + HOST_PREPARATION_LIMITS_V1.maxOutputBytes);
  const candidate = plan as Partial<AssemblyPlanV1>;
  const allowedKeys = new Set([
    "version", "assemblySurface", "operation", "requestId", "limits", "messages", "providerMessages",
    "customPhasePlan",
    "workPolicyMessages", "workspaceUsageMessages", "completionCriteriaMessages", "renderPolicyMessages",
    "loomPolicy", "loomBlocks",
    "children", "childDescriptors", "resultSlots", "activationEvidence", "tokenEvidence",
    "profileOutputLimits", "inputRevisions", "inputRevisionSet", "deltas", "deferredDeltas",
    "seals", "privateEvidence", "snapshotId",
  ]);
  if (
    Object.keys(plan).some((key) => !allowedKeys.has(key))
    || candidate.version !== 1
    || candidate.assemblySurface !== "WORK"
    || candidate.operation !== AGENT_ASSEMBLY_OPERATION
    || typeof candidate.requestId !== "string"
    || bytes(candidate.requestId) > 256
    || typeof candidate.snapshotId !== "string"
    || candidate.snapshotId.length === 0
    || bytes(candidate.snapshotId) > 256
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Unsupported or unbounded assembly plan envelope");
  }
  const candidateLimits = assertPreparationLimits(candidate.limits);
  for (const key of Object.keys(candidateLimits) as (keyof PreparationLimitsV1)[]) {
    if (candidateLimits[key] > trusted[key]) {
      throw new AssemblyPlanValidationError("limit_exceeded", `Assembly limit ${key} exceeds the trusted snapshot limit`);
    }
  }
  if (
    !Array.isArray(candidate.children)
    || !Array.isArray(candidate.childDescriptors)
    || !Array.isArray(candidate.resultSlots)
    || !Array.isArray(candidate.providerMessages)
    || !Array.isArray(candidate.messages)
    || !Array.isArray(candidate.workPolicyMessages)
    || !Array.isArray(candidate.workspaceUsageMessages)
    || !candidate.customPhasePlan
    || typeof candidate.customPhasePlan !== "object"
    || Array.isArray(candidate.customPhasePlan)
    || !Array.isArray(candidate.completionCriteriaMessages)
    || !Array.isArray(candidate.renderPolicyMessages)
    || !candidate.loomPolicy
    || !Array.isArray(candidate.loomBlocks)
    || !Array.isArray(candidate.seals)
    || !Array.isArray(candidate.activationEvidence)
    || !Array.isArray(candidate.tokenEvidence)
    || !Array.isArray(candidate.profileOutputLimits)
    || !Array.isArray(candidate.deltas)
    || !Array.isArray(candidate.deferredDeltas)
    || !candidate.limits
    || typeof candidate.limits !== "object"
    || !candidate.inputRevisions
    || !candidate.inputRevisionSet
    || typeof candidate.privateEvidence !== "object"
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly plan is not closed");
  }
  const customPhasePlan = candidate.customPhasePlan as AgentRuntimePhaseCompileResultV1;
  if (
    Object.keys(customPhasePlan).some((key) => !["status", "phases", "issues", "omittedPhaseIds"].includes(key))
    || !["ready", "repair_required", "failed"].includes(customPhasePlan.status)
    || !Array.isArray(customPhasePlan.phases)
    || !Array.isArray(customPhasePlan.issues)
    || !Array.isArray(customPhasePlan.omittedPhaseIds)
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Custom phase plan is not closed");
  }
  const recomputedCustomPhasePlan = compileAgentRuntimePhases(
    customPhasePlan.phases as readonly AgentCustomPhaseV1[],
  );
  if (
    recomputedCustomPhasePlan.status === "failed"
    || recomputedCustomPhasePlan.phases.length !== customPhasePlan.phases.length
    || customPhasePlan.phases.some((phase, index) => {
      const expected = recomputedCustomPhasePlan.phases[index];
      if (
        !expected
        || phase.index !== index
        || phase.id !== expected.id
        || (phase.sourceStatus !== "verified" && phase.sourceStatus !== "unverified")
        || canonical(phase.sourceIdentity) !== canonical(expected.sourceIdentity)
      ) return true;
      return canonical(phase) !== canonical({ ...expected, sourceStatus: phase.sourceStatus });
    })
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Custom phase plan is not source-bound");
  }
  let validatedLoomPolicy: LoomPolicyBucketsV1;
  try {
    validatedLoomPolicy = parseLoomPolicyBuckets(candidate.loomPolicy);
  } catch {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly Loom policy is invalid");
  }
  const limits = assertPreparationLimits(candidate.limits);
  for (const [index, raw] of candidate.loomBlocks.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AssemblyPlanValidationError("invalid_input", `Invalid Loom block ${index}`);
    }
    const block = raw as Record<string, unknown>;
    const source = block.source;
    if (
      Object.keys(block).some((key) => !["source", "content"].includes(key))
      || typeof block.content !== "string"
      || bytes(block.content) > limits.maxOperationBytes
      || !source
      || typeof source !== "object"
      || Array.isArray(source)
    ) throw new AssemblyPlanValidationError("invalid_input", `Invalid Loom block ${index}`);
    const sourceRecord = source as Record<string, unknown>;
    if (
      Object.keys(sourceRecord).some((key) => !["kind", "blockId", "presetRevision", "blockRevision", "promptOrder"].includes(key))
      || sourceRecord.kind !== "loom_block"
      || typeof sourceRecord.blockId !== "string"
      || !Number.isSafeInteger(sourceRecord.presetRevision)
      || (sourceRecord.presetRevision as number) < 0
      || !Number.isSafeInteger(sourceRecord.blockRevision)
      || (sourceRecord.blockRevision as number) < 0
      || !Number.isSafeInteger(sourceRecord.promptOrder)
      || (sourceRecord.promptOrder as number) < 0
    ) throw new AssemblyPlanValidationError("invalid_input", `Invalid Loom block ${index} source`);
  }
  const privateEvidence = candidate.privateEvidence as Partial<AssemblyPrivateEvidenceV1> & Record<string, unknown>;
  const cognitionEvidence = privateEvidence.cognition;
  if (
    Array.isArray(candidate.privateEvidence)
    || !Array.isArray(privateEvidence.activation)
    || (cognitionEvidence !== undefined && !Array.isArray(cognitionEvidence))
    || !privateEvidence.token
    || typeof privateEvidence.token !== "object"
    || Array.isArray(privateEvidence.token)
    || typeof privateEvidence.inputRevisionDigest !== "string"
    || Object.keys(privateEvidence).some((key) => !["activation", "cognition", "token", "inputRevisionDigest"].includes(key))
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Invalid private assembly evidence");
  }
  const cognitionEvidenceKeys = new Set([
    "kind", "phase", "section", "blockId", "expectedPresetRevision", "expectedBlockRevision",
    "actualPresetRevision", "actualBlockRevision", "order", "promptOrder", "decision",
    "ruleSourceRevision", "tokenCost", "byteCost",
  ]);
  const privateActivationKeys = new Set(["blockIndex", "blockId", "hasChild", "referenceCount"]);
  const privateWorldInfoKeys = new Set(["kind", "entryId", "uid", "activated", "origin", "keyword", "vectorScore", "vectorDisposition", "state"]);
  const privateWorldStateKeys = new Set(["stickyLeft", "cooldownLeft", "delayCount", "active"]);
  const privateMacroKeys = new Set(["kind", "blockId", "operation", "inputBytes", "outputBytes"]);
  const privateRegexKeys = new Set(["kind", "scriptId", "operation", "inputBytes", "outputBytes"]);
  const boundedEvidenceText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && bytes(value) <= 256;
  const boundedEvidenceBytes = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= limits.maxOperationBytes;
  const validKeywordProvenance = (value: unknown): boolean => {
    if (value === null) return true;
    const projected = projectActivationProvenance(value);
    return projected !== undefined && canonical(projected) === canonical(value);
  };
  const validVectorDisposition = (value: unknown): boolean => {
    if (value === null) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const disposition = value as Record<string, unknown>;
    return Object.keys(disposition).every((key) => ["code", "conflictingEntryId", "conflictingSource"].includes(key))
      && Object.keys(disposition).length === 3
      && boundedEvidenceText(disposition.code)
      && (disposition.conflictingEntryId === null || boundedEvidenceText(disposition.conflictingEntryId))
      && (disposition.conflictingSource === null || boundedEvidenceText(disposition.conflictingSource));
  };
  for (const entry of privateEvidence.activation) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid private activation evidence");
    }
    const record = entry as Record<string, unknown>;
    if (record.kind === undefined) {
      if (
        Object.keys(record).some((key) => !privateActivationKeys.has(key))
        || !Number.isSafeInteger(record.blockIndex)
        || (record.blockIndex as number) < 0
        || !boundedEvidenceText(record.blockId)
        || typeof record.hasChild !== "boolean"
        || !Number.isSafeInteger(record.referenceCount)
        || (record.referenceCount as number) < 0
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid private block activation evidence");
    } else if (record.kind === "world_info") {
      const state = record.state;
      if (
        Object.keys(record).some((key) => !privateWorldInfoKeys.has(key))
        || !boundedEvidenceText(record.entryId)
        || !boundedEvidenceText(record.uid)
        || typeof record.activated !== "boolean"
        || !boundedEvidenceText(record.origin)
        || !("keyword" in record)
        || !validKeywordProvenance(record.keyword)
        || !("vectorScore" in record)
        || (record.vectorScore !== null && (typeof record.vectorScore !== "number" || !Number.isFinite(record.vectorScore)))
        || !("vectorDisposition" in record)
        || !validVectorDisposition(record.vectorDisposition)
        || !state || typeof state !== "object" || Array.isArray(state)
        || Object.keys(state).some((key) => !privateWorldStateKeys.has(key))
        || !Number.isSafeInteger((state as Record<string, unknown>).stickyLeft)
        || !Number.isSafeInteger((state as Record<string, unknown>).cooldownLeft)
        || !Number.isSafeInteger((state as Record<string, unknown>).delayCount)
        || typeof (state as Record<string, unknown>).active !== "boolean"
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid private world-info evidence");
    } else if (record.kind === "macro") {
      if (
        Object.keys(record).some((key) => !privateMacroKeys.has(key))
        || (record.blockId !== null && !boundedEvidenceText(record.blockId))
        || !boundedEvidenceText(record.operation)
        || !boundedEvidenceBytes(record.inputBytes)
        || !boundedEvidenceBytes(record.outputBytes)
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid private macro evidence");
    } else if (record.kind === "regex") {
      if (
        Object.keys(record).some((key) => !privateRegexKeys.has(key))
        || !boundedEvidenceText(record.scriptId)
        || !boundedEvidenceText(record.operation)
        || !boundedEvidenceBytes(record.inputBytes)
        || !boundedEvidenceBytes(record.outputBytes)
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid private regex evidence");
    } else {
      throw new AssemblyPlanValidationError("invalid_input", "Unknown private activation evidence");
    }
  }
  const privateToken = privateEvidence.token as Record<string, unknown>;
  if (
    Object.keys(privateToken).some((key) => !["snapshotId", "inputBytes", "providerMessageCount"].includes(key))
    || typeof privateToken.snapshotId !== "string"
    || privateToken.snapshotId.length === 0
    || typeof privateToken.inputBytes !== "number"
    || !Number.isSafeInteger(privateToken.inputBytes)
    || privateToken.inputBytes < 0
    || privateToken.inputBytes > limits.maxInputBytes
    || typeof privateToken.providerMessageCount !== "number"
    || !Number.isSafeInteger(privateToken.providerMessageCount)
    || privateToken.providerMessageCount < 0
    || privateToken.providerMessageCount > limits.maxPromptBlocks * 16
    || bytes(privateEvidence.inputRevisionDigest) > 256
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Invalid private token evidence or limits");
  }
  for (const entry of cognitionEvidence ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid private cognition evidence");
    }
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !cognitionEvidenceKeys.has(key))
      || record.kind !== "cognition_phase"
      || (record.phase !== "WORK" && record.phase !== "PREPARE_COMMIT" && record.phase !== "RENDER")
      || (record.section !== "workPolicy" && record.section !== "workspaceUsage" && record.section !== "completionCriteria" && record.section !== "renderPolicy")
      || typeof record.blockId !== "string"
      || record.blockId.length === 0
      || bytes(record.blockId) > 256
      || !Number.isSafeInteger(record.expectedPresetRevision)
      || (record.expectedPresetRevision as number) < 0
      || !Number.isSafeInteger(record.expectedBlockRevision)
      || (record.expectedBlockRevision as number) < 0
      || !Number.isSafeInteger(record.actualPresetRevision)
      || (record.actualPresetRevision as number) < 0
      || !Number.isSafeInteger(record.actualBlockRevision)
      || (record.actualBlockRevision as number) < 0
      || !Number.isSafeInteger(record.order)
      || (record.order as number) < 0
      || !Number.isSafeInteger(record.promptOrder)
      || (record.promptOrder as number) < 0
      || record.decision !== "selected"
      || typeof record.ruleSourceRevision !== "string"
      || bytes(record.ruleSourceRevision) > 256
      || record.ruleSourceRevision !== `${record.actualPresetRevision}:${record.actualBlockRevision}`
      || !Number.isSafeInteger(record.tokenCost)
      || (record.tokenCost as number) < 0
      || (record.tokenCost as number) > limits.maxOperationBytes
      || !Number.isSafeInteger(record.byteCost)
      || (record.byteCost as number) < 0
      || (record.byteCost as number) > limits.maxOperationBytes
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid cognition activation evidence");
    }
    if (record.expectedPresetRevision !== record.actualPresetRevision || record.expectedBlockRevision !== record.actualBlockRevision) {
      throw new AssemblyPlanValidationError("invalid_input", "Cognition activation source revision mismatch");
    }
  }
  const validDeltaRevision = (value: unknown): boolean =>
    value === undefined
      || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      || (typeof value === "string" && value.length > 0 && bytes(value) <= 256);
  const validateDelta = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid assembly delta");
    }
    const delta = value as Record<string, unknown>;
    const hasOnly = (keys: readonly string[]): boolean => Object.keys(delta).every((key) => keys.includes(key));
    if (delta.kind === "macro_variable") {
      if (
        !hasOnly(["kind", "scope", "key", "operation", "value", "expectedRevision"])
        || !["local", "global", "chat"].includes(String(delta.scope))
        || typeof delta.key !== "string" || delta.key.length === 0 || bytes(delta.key) > 256
        || !["set", "delete"].includes(String(delta.operation))
        || (delta.value !== undefined && (typeof delta.value !== "string" || bytes(delta.value) > limits.maxOperationBytes))
        || !validDeltaRevision(delta.expectedRevision)
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid macro-variable delta");
      return;
    }
    if (delta.kind === "world_info_state") {
      const afterState = delta.afterState;
      if (
        !hasOnly(["kind", "entryId", "operation", "state", "afterState", "expectedRevision"])
        || typeof delta.entryId !== "string" || delta.entryId.length === 0 || bytes(delta.entryId) > 256
        || !["activate", "deactivate", "set_cooldown"].includes(String(delta.operation))
        || !["active", "inactive", "cooldown"].includes(String(delta.state))
        || !afterState || typeof afterState !== "object" || Array.isArray(afterState)
        || !Object.keys(afterState as object).every((key) => ["active", "stickyLeft", "cooldownLeft", "delayCount"].includes(key))
        || typeof (afterState as Record<string, unknown>).active !== "boolean"
        || !["stickyLeft", "cooldownLeft", "delayCount"].every((key) =>
          Number.isSafeInteger((afterState as Record<string, unknown>)[key])
          && Number((afterState as Record<string, unknown>)[key]) >= 0)
        || (delta.operation === "activate" && (delta.state !== "active" || !(afterState as Record<string, unknown>).active))
        || (delta.operation === "deactivate" && (delta.state !== "inactive" || (afterState as Record<string, unknown>).active))
        || (delta.operation === "set_cooldown" && (delta.state !== "cooldown" || (afterState as Record<string, unknown>).active))
        || !validDeltaRevision(delta.expectedRevision)
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid world-info delta");
      return;
    }
    if (delta.kind === "source_message") {
      if (
        !hasOnly(["kind", "sourceMessageId", "operation", "role", "content", "swipeId", "expectedRevision"])
        || typeof delta.sourceMessageId !== "string" || delta.sourceMessageId.length === 0 || bytes(delta.sourceMessageId) > 256
        || !["create", "update", "delete"].includes(String(delta.operation))
        || (delta.role !== undefined && !["system", "user", "assistant", "tool"].includes(String(delta.role)))
        || (delta.content !== undefined && (typeof delta.content !== "string" || bytes(delta.content) > limits.maxOperationBytes))
        || (delta.swipeId !== undefined && (
          !Number.isSafeInteger(delta.swipeId)
          || Number(delta.swipeId) < 0
        ))
        || !validDeltaRevision(delta.expectedRevision)
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid source-message delta");
      return;
    }
    if (delta.kind === "chat_metadata") {
      if (
        !hasOnly(["kind", "key", "operation", "value", "expectedRevision"])
        || typeof delta.key !== "string" || delta.key.length === 0 || bytes(delta.key) > 256
        || !["set", "delete"].includes(String(delta.operation))
        || (delta.value !== undefined && delta.value !== null
          && typeof delta.value !== "string" && typeof delta.value !== "number" && typeof delta.value !== "boolean")
        || (typeof delta.value === "string" && bytes(delta.value) > limits.maxOperationBytes)
        || (typeof delta.value === "number" && !Number.isFinite(delta.value))
        || !validDeltaRevision(delta.expectedRevision)
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid chat-metadata delta");
      return;
    }
    if (delta.kind === "regex_action") {
      if (
        !hasOnly(["kind", "scriptId", "operation", "expectedRevision"])
        || typeof delta.scriptId !== "string" || delta.scriptId.length === 0 || bytes(delta.scriptId) > 256
        || !["apply", "skip", "disable"].includes(String(delta.operation))
        || !validDeltaRevision(delta.expectedRevision)
      ) throw new AssemblyPlanValidationError("invalid_input", "Invalid regex-action delta");
      return;
    }
    throw new AssemblyPlanValidationError("invalid_input", "Unknown assembly delta kind");
  };
  const allDeltas = [...(candidate.deltas ?? []), ...(candidate.deferredDeltas ?? [])] as readonly unknown[];
  if (allDeltas.length > limits.maxPromptBlocks * 16) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Assembly delta limit exceeded");
  }
  for (const delta of allDeltas) validateDelta(delta);
  const revisionSet = (value: unknown): value is InputRevisionSetV1 => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const revisionCollectionKeys = [
      "revisions", "entries", "target", "chat", "messages", "preset", "blocks", "config",
      "slotBinding", "connection", "endpoint", "credential", "participants", "worldLore",
      "databank", "settings", "variables", "regex", "cognition", "readiness",
    ] as const;
    const allowedRevisionKeys = new Set(["version", "digest", ...revisionCollectionKeys]);
    const revisionKeys = new Set(["kind", "domain", "id", "revision", "digest"]);
    if (
      Object.keys(value).some((key) => !allowedRevisionKeys.has(key))
      || record.version !== 1
      || typeof record.digest !== "string"
      || record.digest.length === 0
      || bytes(record.digest) > 256
    ) return false;
    const isRevision = (revision: unknown): boolean => {
      if (!revision || typeof revision !== "object" || Array.isArray(revision)) return false;
      const entry = revision as Record<string, unknown>;
      return !Object.keys(entry).some((key) => !revisionKeys.has(key))
        && typeof entry.kind === "string"
        && entry.kind.length > 0
        && bytes(entry.kind) <= 256
        && (entry.domain === undefined || (typeof entry.domain === "string" && entry.domain.length > 0 && bytes(entry.domain) <= 256))
        && typeof entry.id === "string"
        && entry.id.length > 0
        && bytes(entry.id) <= 256
        && ((typeof entry.revision === "string" && entry.revision.length > 0 && bytes(entry.revision) <= 256)
          || (typeof entry.revision === "number" && Number.isSafeInteger(entry.revision) && entry.revision >= 0))
        && typeof entry.digest === "string"
        && entry.digest.length > 0
        && bytes(entry.digest) <= 256;
    };
    return revisionCollectionKeys.every((key) => {
      const collection = record[key];
      return Array.isArray(collection)
        && collection.length <= HOST_PREPARATION_LIMITS_V1.maxPromptBlocks * 32
        && collection.every(isRevision);
    });
  };
  if (
    !revisionSet(candidate.inputRevisionSet)
    || !revisionSet(candidate.inputRevisions)
    || candidate.inputRevisions.digest !== candidate.inputRevisionSet.digest
    || candidate.inputRevisionSet.digest !== shaDigest(candidate.inputRevisionSet.revisions)
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Invalid input revision set");
  }
  if (
    privateEvidence.inputRevisionDigest !== candidate.inputRevisionSet.digest
    || privateToken.snapshotId !== candidate.snapshotId
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Private evidence is not bound to the assembly plan");
  }
  if (
    candidate.childDescriptors.length > limits.maxPromptBlocks
    || candidate.children.length > limits.maxPromptBlocks
    || candidate.resultSlots.length > limits.maxPromptBlocks
    || candidate.messages.length > limits.maxPromptBlocks * 16
    || candidate.providerMessages.length > limits.maxPromptBlocks * 16
    || candidate.childDescriptors.length !== candidate.children.length
    || candidate.messages.length !== candidate.providerMessages.length
  ) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Assembly plan collection limits exceeded");
  }
  if (
    canonical(candidate.childDescriptors) !== canonical(candidate.children)
    || canonical(candidate.messages) !== canonical(candidate.providerMessages)
    || canonical(candidate.inputRevisionSet) !== canonical(candidate.inputRevisions)
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly plan aliases do not match");
  }
  const slotByName = new Map<string, AssemblyResultSlotV1>();
  const slotsByIndex = new Map<number, AssemblyResultSlotV1>();
  const resultSlotRecordKeys = new Set([
    "childId", "slotIndex", "resultName", "producerBlockIndex", "producerBlockId", "maxBytes", "seal",
  ]);
  for (const slot of candidate.resultSlots) {
    if (
      !slot
      || typeof slot !== "object"
      || Array.isArray(slot)
      || Object.keys(slot).some((key) => !resultSlotRecordKeys.has(key))
      || typeof slot.childId !== "string"
      || slot.childId.length === 0
      || bytes(slot.childId) > 256
      || !Number.isSafeInteger(slot.slotIndex)
      || slot.slotIndex < 0
      || typeof slot.resultName !== "string"
      || !RESULT_NAME_PATTERN.test(slot.resultName)
      || !Number.isSafeInteger(slot.producerBlockIndex)
      || slot.producerBlockIndex < 0
      || typeof slot.producerBlockId !== "string"
      || slot.producerBlockId.length === 0
      || bytes(slot.producerBlockId) > 256
      || !Number.isSafeInteger(slot.maxBytes)
      || slot.maxBytes < 0
      || slot.maxBytes > Math.min(limits.maxOutputBytes, limits.maxOperationBytes)
      || typeof slot.seal !== "string"
      || slot.seal.length === 0
      || bytes(slot.seal) > 256
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid result slot");
    }
    if (slotByName.has(slot.resultName) || slotsByIndex.has(slot.slotIndex)) throw new AssemblyPlanValidationError("duplicate_result_producer", "Duplicate result slot");
    slotByName.set(slot.resultName, slot);
    slotsByIndex.set(slot.slotIndex, slot);
  }
  if (candidate.resultSlots.length !== candidate.children.length) {
    throw new AssemblyPlanValidationError("invalid_input", "Every child must have one direct result slot");
  }
  const childRecordKeys = new Set([
    "childId", "slotIndex", "traversalIndex", "blockIndex", "blockId", "profileId", "resultName",
    "task", "taskBytes", "maxOutputBytes", "maxOutputTokens", "required", "toolIds", "streamActivity", "sourceOffset",
    "failurePolicy", "producerSeal",
  ]);
  const childrenByIndex = new Map<number, AssemblyChildDescriptorV1>();
  for (let expectedIndex = 0; expectedIndex < candidate.children.length; expectedIndex++) {
    const child = candidate.children[expectedIndex]!;
    if (
      !child
      || typeof child !== "object"
      || Array.isArray(child)
      || Object.keys(child).some((key) => !childRecordKeys.has(key))
      || child.slotIndex !== expectedIndex
      || child.traversalIndex !== expectedIndex
      || !Number.isSafeInteger(child.slotIndex)
      || typeof child.childId !== "string"
      || child.childId.length === 0
      || bytes(child.childId) > 256
      || typeof child.blockId !== "string"
      || child.blockId.length === 0
      || bytes(child.blockId) > 256
      || !Number.isSafeInteger(child.blockIndex)
      || child.blockIndex < 0
      || typeof child.profileId !== "string"
      || child.profileId.length === 0
      || bytes(child.profileId) > 256
      || typeof child.resultName !== "string"
      || !RESULT_NAME_PATTERN.test(child.resultName)
      || typeof child.task !== "string"
      || child.task.length === 0
      || !Number.isSafeInteger(child.taskBytes)
      || child.taskBytes < 0
      || child.taskBytes > limits.maxOperationBytes
      || bytes(child.task) !== child.taskBytes
      || !Number.isSafeInteger(child.maxOutputBytes)
      || child.maxOutputBytes < 0
      || child.maxOutputBytes > Math.min(limits.maxOutputBytes, limits.maxOperationBytes)
      || !Number.isSafeInteger(child.maxOutputTokens)
      || child.maxOutputTokens < 1
      || child.maxOutputTokens > Math.max(1, Math.ceil(child.maxOutputBytes / 4))
      || typeof child.required !== "boolean"
      || !Array.isArray(child.toolIds)
      || child.toolIds.some((toolId: unknown) => typeof toolId !== "string" || toolId.length === 0 || bytes(toolId) > 256)
      || typeof child.streamActivity !== "boolean"
      || !Number.isSafeInteger(child.sourceOffset)
      || child.sourceOffset < 0
      || (child.failurePolicy !== "required" && child.failurePolicy !== "optional")
      || child.required !== (child.failurePolicy === "required")
      || typeof child.producerSeal !== "string"
      || child.producerSeal.length === 0
      || bytes(child.producerSeal) > 256
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid child descriptor");
    }
    childrenByIndex.set(child.slotIndex, child);
    const slot = slotByName.get(child.resultName);
    if (
      !slot
      || slot.slotIndex !== child.slotIndex
      || slot.childId !== child.childId
      || slot.maxBytes !== child.maxOutputBytes
      || slot.producerBlockIndex !== child.blockIndex
      || slot.producerBlockId !== child.blockId
      || slot.seal !== child.producerSeal
      || child.producerSeal !== digest({
        slotIndex: child.slotIndex,
        blockIndex: child.blockIndex,
        blockId: child.blockId,
        resultName: child.resultName,
      })
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Child/result slot mismatch");
    }
  }
  for (let index = 0; index < candidate.childDescriptors.length; index++) {
    const descriptor = candidate.childDescriptors[index]!;
    const child = candidate.children[index]!;
    if (!descriptor || descriptor.childId !== child.childId || descriptor.slotIndex !== child.slotIndex || descriptor.resultName !== child.resultName || descriptor.producerSeal !== child.producerSeal) {
      throw new AssemblyPlanValidationError("invalid_input", "Child descriptor alias mismatch");
    }
  }
  for (const slot of candidate.resultSlots) {
    const child = childrenByIndex.get(slot.slotIndex);
    if (!child || child.resultName !== slot.resultName) throw new AssemblyPlanValidationError("invalid_input", "Result slot has no direct child");
  }
  const occurrences: AssemblySealV1[] = [];
  const maxPlanMessages = limits.maxPromptBlocks * 16;
  const maxSegmentsPerMessage = Math.max(1, maxPlanMessages);
  const maxSegmentsTotal = Math.max(1, maxPlanMessages * 16);
  let totalSegments = 0;
  if (candidate.seals.length > maxSegmentsTotal) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Assembly seal/segment limit exceeded");
  }
  const messageKeys = new Set(["role", "segments", "name", "blockIndex", "blockId", "contentKind", "provenance"]);
  const literalKeys = new Set(["kind", "text", "bytes"]);
  const resultSlotKeys = new Set(["kind", "slotIndex", "resultName", "maxBytes", "bytes"]);
  const mediaKeys = new Set(["kind", "mediaType", "mediaId", "mimeType", "byteLength", "sha256", "bytes"]);
  const roles = new Set(["system", "developer", "user", "assistant", "tool"]);
  const sealKeys = new Set(["kind", "resultName", "slotIndex", "blockIndex", "blockId", "sequence"]);
  for (const seal of candidate.seals) {
    if (
      !seal
      || typeof seal !== "object"
      || Array.isArray(seal)
      || Object.keys(seal).some((key) => !sealKeys.has(key))
      || (seal.kind !== "producer" && seal.kind !== "consumer")
      || typeof seal.resultName !== "string"
      || !RESULT_NAME_PATTERN.test(seal.resultName)
      || !Number.isSafeInteger(seal.slotIndex)
      || seal.slotIndex < 0
      || !Number.isSafeInteger(seal.blockIndex)
      || seal.blockIndex < 0
      || typeof seal.blockId !== "string"
      || seal.blockId.length === 0
      || bytes(seal.blockId) > 256
      || !Number.isSafeInteger(seal.sequence)
      || seal.sequence < 0
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid assembly seal");
    }
  }
  if (candidate.profileOutputLimits.length > limits.maxPromptBlocks) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Profile output limit count exceeds the plan limit");
  }
  const profileLimitIds = new Set<string>();
  for (const profileLimit of candidate.profileOutputLimits) {
    if (
      !profileLimit
      || typeof profileLimit !== "object"
      || Array.isArray(profileLimit)
      || Object.keys(profileLimit).some((key) => key !== "profileId" && key !== "maxOutputTokens")
      || typeof profileLimit.profileId !== "string"
      || profileLimit.profileId.length === 0
      || bytes(profileLimit.profileId) > 256
      || profileLimitIds.has(profileLimit.profileId)
      || !Number.isSafeInteger(profileLimit.maxOutputTokens)
      || profileLimit.maxOutputTokens < 1
      || profileLimit.maxOutputTokens > Math.max(1, Math.ceil(Math.min(limits.maxOutputBytes, limits.maxOperationBytes) / 4))
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid profile output limit");
    }
    profileLimitIds.add(profileLimit.profileId);
  }
  const activationKeys = new Set(["kind", "profileId", "authorized", "tokenCost"]);
  const tokenKeys = new Set(["kind", "profileId", "estimatedInputTokens", "estimatedOutputTokens"]);
  if (candidate.activationEvidence.length !== candidate.children.length || candidate.tokenEvidence.length !== candidate.children.length) {
    throw new AssemblyPlanValidationError("invalid_input", "Child activation and token evidence count mismatch");
  }
  for (const evidence of candidate.activationEvidence) {
    if (
      !evidence
      || typeof evidence !== "object"
      || Array.isArray(evidence)
      || Object.keys(evidence).some((key) => !activationKeys.has(key))
      || evidence.kind !== "activation"
      || typeof evidence.profileId !== "string"
      || evidence.profileId.length === 0
      || bytes(evidence.profileId) > 256
      || typeof evidence.authorized !== "boolean"
      || !Number.isSafeInteger(evidence.tokenCost)
      || evidence.tokenCost < 0
      || evidence.tokenCost > limits.maxOperationBytes
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid activation evidence");
    }
  }
  for (const evidence of candidate.tokenEvidence) {
    if (
      !evidence
      || typeof evidence !== "object"
      || Array.isArray(evidence)
      || Object.keys(evidence).some((key) => !tokenKeys.has(key))
      || evidence.kind !== "token"
      || typeof evidence.profileId !== "string"
      || evidence.profileId.length === 0
      || bytes(evidence.profileId) > 256
      || !Number.isSafeInteger(evidence.estimatedInputTokens)
      || evidence.estimatedInputTokens < 0
      || !Number.isSafeInteger(evidence.estimatedOutputTokens)
      || evidence.estimatedOutputTokens < 0
      || evidence.estimatedOutputTokens > limits.maxOperationBytes
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid token evidence");
    }
  }
  for (let index = 0; index < candidate.children.length; index++) {
    const child = candidate.children[index]!;
    const activation = candidate.activationEvidence[index]!;
    const token = candidate.tokenEvidence[index]!;
    if (activation.profileId !== child.profileId || token.profileId !== child.profileId) {
      throw new AssemblyPlanValidationError("invalid_input", "Child activation/token evidence profile mismatch");
    }
  }
  let providerLiteralBytes = 0;
  let providerReservedBytes = 0;
  const providerProvenanceKeys = new Set<string>();
  for (const message of candidate.providerMessages) {
    if (
      !message
      || typeof message !== "object"
      || Array.isArray(message)
      || Object.keys(message).some((key) => !messageKeys.has(key))
      || !isValidAssemblyMessageProvenance(message.provenance)
      || !Array.isArray(message.segments)
      || !roles.has(message.role)
      || message.contentKind !== "segments"
      || (message.name !== undefined && (typeof message.name !== "string" || bytes(message.name) > 256))
      || (message.blockIndex !== undefined && (!Number.isSafeInteger(message.blockIndex) || message.blockIndex < 0))
      || (message.blockId !== undefined && (typeof message.blockId !== "string" || bytes(message.blockId) > 256))
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Invalid provider message envelope");
    }
    if (message.segments.length > maxSegmentsPerMessage) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Provider message segment limit exceeded");
    }
    totalSegments += message.segments.length;
    if (totalSegments > maxSegmentsTotal) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Assembly total segment limit exceeded");
    }
    const provenanceKey = JSON.stringify([
      message.provenance.kind,
      message.provenance.sourceId,
      message.provenance.sourceRevision,
      message.provenance.sourceIndex,
    ]);
    if (providerProvenanceKeys.has(provenanceKey)) {
      throw new AssemblyPlanValidationError("invalid_input", "Duplicate provider messages share provenance");
    }
    providerProvenanceKeys.add(provenanceKey);
    for (const segment of message.segments) {
      if (segment.kind === "literal") {
        if (
          Object.keys(segment).some((key) => !literalKeys.has(key))
          || typeof segment.text !== "string"
          || agentMarkersPresent(segment.text)
          || !Number.isSafeInteger(segment.bytes)
          || segment.bytes < 0
          || segment.bytes > limits.maxOperationBytes
          || bytes(segment.text) !== segment.bytes
        ) {
          throw new AssemblyPlanValidationError("invalid_input", "Literal byte mismatch");
        }
        providerLiteralBytes += segment.bytes;
        continue;
      }
      if (segment.kind === "media") {
        const mediaLimit = segment.mediaType === "image"
          ? MAX_IMAGE_BYTES
          : segment.mediaType === "audio"
            ? MAX_AUDIO_BYTES
            : 0;
        if (
          Object.keys(segment).some((key) => !mediaKeys.has(key))
          || message.provenance.kind !== "history"
          || message.role !== "user"
          || typeof segment.mediaId !== "string"
          || segment.mediaId.length === 0
          || bytes(segment.mediaId) > 256
          || typeof segment.mimeType !== "string"
          || !/^(?:image|audio)\/[a-z0-9.+-]{1,96}$/.test(segment.mimeType)
          || !Number.isSafeInteger(segment.byteLength)
          || segment.byteLength < 1
          || segment.byteLength > mediaLimit
          || !/^[0-9a-f]{64}$/.test(segment.sha256)
          || segment.bytes !== 0
        ) {
          throw new AssemblyPlanValidationError("invalid_input", "Invalid native media segment");
        }
        continue;
      }
      if (
        Object.keys(segment).some((key) => !resultSlotKeys.has(key))
        || segment.kind !== "result_slot"
        || !Number.isSafeInteger(segment.slotIndex)
        || !slotsByIndex.has(segment.slotIndex)
        || typeof segment.resultName !== "string"
        || !RESULT_NAME_PATTERN.test(segment.resultName)
        || !Number.isSafeInteger(segment.maxBytes)
        || segment.maxBytes < 0
        || segment.maxBytes > Math.min(limits.maxOutputBytes, limits.maxOperationBytes)
        || segment.bytes !== 0
        || !Number.isSafeInteger(message.blockIndex)
        || typeof message.blockId !== "string"
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Invalid direct result slot");
      }
      const slot = slotsByIndex.get(segment.slotIndex)!;
      if (slot.resultName !== segment.resultName || slot.maxBytes !== segment.maxBytes) {
        throw new AssemblyPlanValidationError("invalid_input", "Result slot seal mismatch");
      }
      providerReservedBytes += segment.maxBytes;
      const isProducer = message.blockIndex === slot.producerBlockIndex && message.blockId === slot.producerBlockId;
      occurrences.push(frozen({
        kind: isProducer ? "producer" : "consumer",
        resultName: slot.resultName,
        slotIndex: slot.slotIndex,
        blockIndex: message.blockIndex,
        blockId: message.blockId,
        sequence: occurrences.length,
      }));
    }
  }
  const phaseMessageCollections = [
    candidate.workPolicyMessages,
    candidate.workspaceUsageMessages,
    candidate.completionCriteriaMessages,
    candidate.renderPolicyMessages,
  ];
  const phaseBuckets: readonly LoomPolicyBucketV1[] = ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"];
  let phaseMessageCount = 0;
  let phaseLiteralBytes = 0;
  const phaseBlockIds = new Set<string>();
  for (const [collectionIndex, collection] of phaseMessageCollections.entries()) {
    if (collection.length > limits.maxPromptBlocks * 16) throw new AssemblyPlanValidationError("limit_exceeded", "Cognition policy message limit exceeded");
    for (const message of collection) {
      if (
        !message
        || typeof message !== "object"
        || Array.isArray(message)
        || Object.keys(message).some((key) => !messageKeys.has(key))
        || message.contentKind !== "segments"
        || !Array.isArray(message.segments)
        || (message.name !== undefined && (typeof message.name !== "string" || bytes(message.name) > 256))
        || typeof message.blockId !== "string"
        || message.blockId.length === 0
        || bytes(message.blockId) > 256
        || !Number.isSafeInteger(message.blockIndex)
        || message.blockIndex < 0
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Invalid cognition policy message envelope");
      }
      if (!isValidAssemblyMessageProvenance(message.provenance)) {
        throw new AssemblyPlanValidationError("invalid_input", "Invalid cognition policy message provenance");
      }
      if (message.segments.length > maxSegmentsPerMessage) {
        throw new AssemblyPlanValidationError("limit_exceeded", "Cognition message segment limit exceeded");
      }
      totalSegments += message.segments.length;
      if (totalSegments > maxSegmentsTotal) {
        throw new AssemblyPlanValidationError("limit_exceeded", "Assembly total segment limit exceeded");
      }
      const loom = message.provenance.loom;
      const bucket = phaseBuckets[collectionIndex];
      const policyEntry = loom && bucket !== undefined
        ? validatedLoomPolicy[bucket].find((entry) => entry.id === loom.entryId)
        : undefined;
      if (
        !loom
        || !policyEntry
        || loom.bucket !== bucket
        || loom.destination !== policyEntry.destination
        || loom.checkpoint !== policyEntry.checkpoint
        || canonical(loom.source) !== canonical(policyEntry.source)
        || canonical(loom.condition) !== canonical(policyEntry.condition)
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Cognition Loom provenance is not source-bound");
      }
      const phaseEntryKey = `${loom.destination}\u0000${loom.entryId}`;
      if (phaseBlockIds.has(phaseEntryKey)) {
        throw new AssemblyPlanValidationError("invalid_input", "Duplicate cognition policy provenance");
      }
      phaseBlockIds.add(phaseEntryKey);
      for (const segment of message.segments) {
        if (
          !segment
          || typeof segment !== "object"
          || Array.isArray(segment)
          || segment.kind !== "literal"
          || Object.keys(segment).some((key) => !literalKeys.has(key))
          || typeof segment.text !== "string"
          || agentMarkersPresent(segment.text)
          || !Number.isSafeInteger(segment.bytes)
          || segment.bytes < 0
          || segment.bytes > limits.maxOperationBytes
          || bytes(segment.text) !== segment.bytes
        ) {
          throw new AssemblyPlanValidationError("invalid_input", "Cognition policy messages must contain bounded literal segments");
        }
        phaseLiteralBytes += segment.bytes;
      }
      phaseMessageCount += 1;
    }
  }
  if (candidate.providerMessages.length + phaseMessageCount > maxPlanMessages) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Provider and cognition policy message limit exceeded");
  }
  for (const collection of phaseMessageCollections) {
    for (let order = 0; order < collection.length; order += 1) {
      const provenance = collection[order]!.provenance;
      if (
        !isValidAssemblyMessageProvenance(provenance)
        || provenance.kind !== "cognition"
        || provenance.sourceId !== collection[order]!.blockId
        || provenance.sourceIndex !== order
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Cognition policy message provenance is not source-bound");
      }
    }
  }
  const totalLiteralBytes = providerLiteralBytes + phaseLiteralBytes;
  if (totalLiteralBytes > limits.maxInputBytes || totalLiteralBytes + providerReservedBytes > limits.maxInputBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Provider and cognition policy bytes exceed host limits");
  }
  if (providerReservedBytes > limits.maxCumulativeExpansionBytes || providerReservedBytes > limits.maxOutputBytes) {
    throw new AssemblyPlanValidationError("limit_exceeded", "Provider result reservation exceeds host limits");
  }
  const cognitionEvidenceList = cognitionEvidence ?? [];
  if (cognitionEvidenceList.length !== phaseMessageCount) {
    throw new AssemblyPlanValidationError("invalid_input", "Cognition evidence must cover every phase message");
  }
  let cognitionEvidenceIndex = 0;
  for (const [section, phase, collection] of [
    ["workPolicy", "WORK", candidate.workPolicyMessages],
    ["workspaceUsage", "WORK", candidate.workspaceUsageMessages],
    ["completionCriteria", "PREPARE_COMMIT", candidate.completionCriteriaMessages],
    ["renderPolicy", "RENDER", candidate.renderPolicyMessages],
  ] as const) {
    for (let order = 0; order < collection.length; order++) {
      const message = collection[order]!;
      const evidence = cognitionEvidenceList[cognitionEvidenceIndex++] as Record<string, unknown> | undefined;
      const byteCost = message.segments.reduce((total: number, segment: AssemblyMessageSegmentV1) => total + (segment.kind === "literal" ? segment.bytes : 0), 0);
      if (
        !evidence
        || evidence.kind !== "cognition_phase"
        || evidence.phase !== phase
        || evidence.section !== section
        || evidence.blockId !== message.blockId
        || evidence.order !== order
        || evidence.byteCost !== byteCost
        || evidence.tokenCost !== Math.max(1, Math.ceil(byteCost / 4))
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Cognition evidence does not match phase message order or accounting");
      }
    }
  }
  if (cognitionEvidenceIndex !== cognitionEvidenceList.length) {
    throw new AssemblyPlanValidationError("invalid_input", "Cognition evidence contains an extra phase entry");
  }
  if (candidate.seals.length !== occurrences.length) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly seal occurrence count mismatch");
  }
  for (let index = 0; index < occurrences.length; index++) {
    const expected = occurrences[index]!;
    const received = candidate.seals[index]!;
    if (
      received.kind !== expected.kind
      || received.resultName !== expected.resultName
      || received.slotIndex !== expected.slotIndex
      || received.blockIndex !== expected.blockIndex
      || received.blockId !== expected.blockId
      || received.sequence !== expected.sequence
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Assembly seal occurrence mismatch");
    }
  }
  const producers = new Set<string>();
  for (const seal of occurrences) {
    const slot = slotsByIndex.get(seal.slotIndex)!;
    if (seal.kind === "producer") {
      if (producers.has(seal.resultName)) throw new AssemblyPlanValidationError("duplicate_result_producer", "Duplicate producer seal");
      producers.add(seal.resultName);
      if (slot.producerBlockIndex !== seal.blockIndex || slot.producerBlockId !== seal.blockId || slot.seal !== childrenByIndex.get(seal.slotIndex)?.producerSeal) {
        throw new AssemblyPlanValidationError("invalid_input", "Producer seal mismatch");
      }
    } else if (!producers.has(seal.resultName)) {
      throw new AssemblyPlanValidationError("out_of_order_result_reference", "Consumer seal does not follow producer seal");
    }
  }
  for (const slot of candidate.resultSlots) {
    if (!producers.has(slot.resultName)) throw new AssemblyPlanValidationError("missing_result_producer", "Missing producer seal");
  }
}
/**
 * Validate every source relationship the host can prove without executing
 * preprocessing. The worker client separately requires an exact plan match
 * from an independent verifier isolate, which closes transform-dependent
 * omissions, replacements, and reorderings.
 */
export async function validateAssemblyPlanAgainstSnapshotV1(
  plan: AssemblyPlanV1,
  snapshot: GenerationAssemblySnapshotV1,
  trustedLimits: PreparationLimitsV1 = snapshot.limits,
): Promise<void> {
  validateAssemblyPlanV1(plan, trustedLimits);
  if (
    plan.assemblySurface !== snapshot.assemblySurface
    || snapshot.assemblySurface !== "WORK"
    || plan.snapshotId !== snapshot.snapshotId
    || canonical(plan.limits) !== canonical(snapshot.limits)
    || canonical(plan.inputRevisionSet) !== canonical(snapshot.inputRevisionSet)
    || canonical(plan.inputRevisions) !== canonical(snapshot.inputRevisionSet)
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly plan is not bound to the requested snapshot");
  }
  /**
   * Re-run the pure snapshot compiler as the source authority for every
   * provider occurrence. This compares transformed literals as well as
   * provenance and order: macro/regex/world-info changes are accepted only
   * when the frozen snapshot explicitly supplied the corresponding source.
   * The call is deliberately one-way (the compiler invokes structural
   * validation, never this snapshot validator), so malformed worker data
   * cannot recurse through host validation.
   */
  const expectedPlan = await compileAgentAssemblyPlan(snapshot);
  const messageCollections = [
    ["provider", plan.providerMessages, expectedPlan.providerMessages],
    ["workPolicy", plan.workPolicyMessages, expectedPlan.workPolicyMessages],
    ["workspaceUsage", plan.workspaceUsageMessages, expectedPlan.workspaceUsageMessages],
    ["completionCriteria", plan.completionCriteriaMessages, expectedPlan.completionCriteriaMessages],
    ["renderPolicy", plan.renderPolicyMessages, expectedPlan.renderPolicyMessages],
  ] as const;
  for (const [label, actual, expected] of messageCollections) {
    if (canonical(actual) !== canonical(expected)) {
      throw new AssemblyPlanValidationError("invalid_input", `${label} messages are not exact frozen source projections`);
    }
  }
  if (canonical(plan.customPhasePlan) !== canonical(expectedPlan.customPhasePlan)) {
    throw new AssemblyPlanValidationError("invalid_input", "Custom phase plan is not an exact frozen source projection");
  }
  if (canonical(plan.loomPolicy) !== canonical(expectedPlan.loomPolicy)) {
    throw new AssemblyPlanValidationError("invalid_input", "Loom policy is not an exact frozen source projection");
  }
  if (canonical(plan.loomBlocks) !== canonical(expectedPlan.loomBlocks)) {
    throw new AssemblyPlanValidationError("invalid_input", "Loom prompt blocks are not exact frozen source projections");
  }
  const config = parserConfig(configFor(snapshot, undefined));
  const phaseRefs = cognitionPhaseRefs(snapshot, config, expectedPlan.customPhasePlan);
  const cognitionAdmission = cognitionBlockAdmission(expectedPlan.loomPolicy, config, phaseRefs);
  const validationBlocks = snapshot.blocks.map((block) =>
    projectStructuralBlockAdmission(block, snapshot.participants.structuralBlockValues));
  const parsed = parseBlocks(snapshot, config, validationBlocks, cognitionAdmission.excludedBlockOccurrences);
  const expectedProfileOutputLimits = profileOutputLimitsFor(snapshot, config);
  if (canonical(plan.profileOutputLimits) !== canonical(expectedProfileOutputLimits)) {
    throw new AssemblyPlanValidationError("invalid_input", "Profile output limits are not bound to the requested snapshot");
  }
  const expectedChildren: readonly AssemblyChildDescriptorV1[] = expectedPlan.childDescriptors;
  const expectedSlots: readonly AssemblyResultSlotV1[] = expectedPlan.resultSlots;
  const expectedChildrenCanonical = canonical(expectedChildren);
  if (
    canonical(plan.children) !== expectedChildrenCanonical
    || canonical(plan.childDescriptors) !== expectedChildrenCanonical
    || canonical(plan.resultSlots) !== canonical(expectedSlots)
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly child descriptors or result slots are not source-bound");
  }
  const expectedSlotByName = new Map(expectedSlots.map((slot) => [slot.resultName, slot] as const));
  const selected = parsed.filter((item) =>
    item.block.enabled
    && (item.child !== null || item.block.content.length > 0 || item.references.length > 0)
  );
  const mayTransform = (block: SnapshotBlockV1): boolean => {
    const placement = block.role === "user" ? "user_input" : block.role === "assistant" ? "ai_output" : "world_info";
    return block.content.includes("{{")
      || snapshot.regexScripts.some((script) => script.target.includes("prompt") && script.placement.includes(placement))
      || snapshot.worldInfo.entries.some((entry) => entry.wiMarker !== null && entry.wiMarker.length > 0 && block.content.includes(entry.wiMarker));
  };
  const pre = selected.filter((item) => item.block.position === "pre_history");
  const inHistory = selected.filter((item) => item.block.position === "in_history");
  const post = selected.filter((item) => item.block.position === "post_history");
  const history: Array<{ blockIndex: number; depth: number } | null> = snapshot.messages
    .filter((message) => message.id !== snapshot.target.excludedMessageId)
    .map(() => null);
  for (let index = inHistory.length - 1; index >= 0; index -= 1) {
    const item = inHistory[index]!;
    const depth = Math.max(0, Math.floor(item.block.depth));
    const insertionIndex = Math.max(0, Math.min(history.length, history.length - depth));
    history.splice(insertionIndex, 0, { blockIndex: item.blockIndex, depth });
  }
  const emitsDirectBlockMessage = (item: InternalBlockPlan): boolean =>
    item.block.marker !== "world_info_before"
    && item.block.marker !== "world_info_after"
    && (item.child !== null || (!mayTransform(item.block) && item.block.content.length > 0));
  const expectedBlockOrder = [
    ...pre.filter(emitsDirectBlockMessage).map((item) => item.blockIndex),
    ...history.flatMap((entry) => {
      if (!entry) return [];
      const item = selected.find((candidate) => candidate.blockIndex === entry.blockIndex);
      return item && emitsDirectBlockMessage(item) ? [entry.blockIndex] : [];
    }),
    ...post.filter(emitsDirectBlockMessage).map((item) => item.blockIndex),
  ];
  const sourceBlockOrder = [
    ...pre.map((item) => item.blockIndex),
    ...history.flatMap((entry) => entry ? [entry.blockIndex] : []),
    ...post.map((item) => item.blockIndex),
  ];
  const actualBlockMessages = plan.providerMessages.filter((message) => message.blockIndex !== undefined);
  const actualBlockOrder = actualBlockMessages.map((message) => message.blockIndex as number);
  let sourceCursor = -1;
  for (const blockIndex of actualBlockOrder) {
    const sourceIndex = sourceBlockOrder.indexOf(blockIndex);
    if (sourceIndex < 0 || sourceIndex <= sourceCursor) {
      throw new AssemblyPlanValidationError("invalid_input", "Provider block order is not source-bound");
    }
    sourceCursor = sourceIndex;
  }
  let actualCursor = 0;
  for (const blockIndex of expectedBlockOrder) {
    const found = actualBlockOrder.indexOf(blockIndex, actualCursor);
    if (found < 0) throw new AssemblyPlanValidationError("invalid_input", "Provider block order is missing a source block");
    actualCursor = found + 1;
  }
  const blockByIndex = new Map(snapshot.blocks.map((block, index) => [index, block] as const));
  const historySources = snapshot.messages.filter((message) => message.id !== snapshot.target.excludedMessageId);
  const historyById = new Map(historySources.map((message, sourceIndex) => [
    message.id,
    { message, sourceIndex },
  ] as const));
  const cognitionMessagesByBucket: Readonly<Record<LoomPolicyBucketV1, readonly AssemblyProviderMessageV1[]>> = {
    workPolicy: plan.workPolicyMessages,
    workspaceUsage: plan.workspaceUsageMessages,
    completionCriteria: plan.completionCriteriaMessages,
    renderPolicy: plan.renderPolicyMessages,
  };
  const seenProviderProvenance = new Set<string>();
  for (const message of plan.providerMessages) {
    const provenanceKey = canonical(message.provenance);
    if (seenProviderProvenance.has(provenanceKey)) {
      throw new AssemblyPlanValidationError("invalid_input", "Provider provenance occurrence is duplicated");
    }
    seenProviderProvenance.add(provenanceKey);
    const provenance = message.provenance;
    let expectedRevision: string | undefined;
    if (provenance.kind === "history") {
      const source = historyById.get(provenance.sourceId);
      expectedRevision = source?.message.revision;
      const expectedRole = source?.message.is_user ? "user" : "assistant";
      const expectedName = source?.message.name || undefined;
      if (
        source
        && (
          provenance.sourceIndex !== source.sourceIndex
          || message.role !== expectedRole
          || message.name !== expectedName
        )
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Provider history message identity is not source-bound");
      }
    } else if (provenance.kind === "block") {
      const block = blockByIndex.get(message.blockIndex ?? -1);
      expectedRevision = block?.revision;
      if (
        block
        && (
          provenance.sourceId !== block.id
          || provenance.sourceIndex !== message.blockIndex
          || message.blockId !== block.id
        )
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Provider block provenance is not source-bound");
      }
    } else if (provenance.kind === "cognition") {
      const loom = provenance.loom;
      const promptOrder = loom?.source.promptOrder;
      const sourceIndex = provenance.sourceIndex;
      const sourceMessages = loom ? cognitionMessagesByBucket[loom.bucket] : undefined;
      const sourceMessage = Number.isSafeInteger(sourceIndex) && sourceIndex >= 0
        ? sourceMessages?.[sourceIndex]
        : undefined;
      const sourceLoom = sourceMessage?.provenance.loom;
      const block = Number.isSafeInteger(promptOrder) && promptOrder! >= 0
        ? snapshot.blocks[promptOrder!]
        : undefined;
      const cognitionSource = snapshot.agentCognition.cognitionSource;
      const frozenSourceBlock = Number.isSafeInteger(promptOrder)
        ? cognitionSource?.blocks.find((entry) => entry.promptOrder === promptOrder)
        : undefined;
      const policyEntry = loom
        ? plan.loomPolicy[loom.bucket].find((entry) => entry.id === loom.entryId)
        : undefined;
      if (
        !loom
        || !Number.isSafeInteger(promptOrder)
        || promptOrder! < 0
        || promptOrder! >= snapshot.blocks.length
        || !Number.isSafeInteger(sourceIndex)
        || sourceIndex < 0
        || !block
        || block.marker === "category"
        || !sourceMessage
        || sourceMessage.provenance.kind !== "cognition"
        || sourceMessage.provenance.sourceIndex !== sourceIndex
        || sourceMessage.blockId !== block.id
        || sourceMessage.blockIndex !== promptOrder
        || sourceMessage.provenance.sourceId !== provenance.sourceId
        || sourceMessage.provenance.sourceRevision !== provenance.sourceRevision
        || !sourceLoom
        || sourceLoom.entryId !== loom.entryId
        || sourceLoom.bucket !== loom.bucket
        || sourceLoom.destination !== loom.destination
        || sourceLoom.checkpoint !== loom.checkpoint
        || canonical(sourceLoom.source) !== canonical(loom.source)
        || canonical(sourceLoom.condition) !== canonical(loom.condition)
        || !policyEntry
        || policyEntry.destination !== loom.destination
        || policyEntry.checkpoint !== loom.checkpoint
        || canonical(policyEntry.source) !== canonical(loom.source)
        || canonical(policyEntry.condition) !== canonical(loom.condition)
        || provenance.sourceId !== block.id
        || provenance.sourceRevision !== block.revision
        || message.blockId !== block.id
        || message.blockIndex !== promptOrder
        || loom.source.blockId !== block.id
        || String(loom.source.blockRevision) !== block.revision
        || !cognitionSource
        || cognitionSource.presetRevision !== loom.source.presetRevision
        || !frozenSourceBlock
        || frozenSourceBlock.blockId !== block.id
        || frozenSourceBlock.revision !== loom.source.blockRevision
      ) {
        throw new AssemblyPlanValidationError("invalid_input", "Provider cognition provenance is not source-bound");
      }
      expectedRevision = block.revision;
    } else if (provenance.kind === "world_info" && !/^[0-9a-f]{8}$/i.test(provenance.sourceRevision)) {
      throw new AssemblyPlanValidationError("invalid_input", "Provider world-info provenance is not source-bound");
    }
    if (expectedRevision !== undefined && provenance.sourceRevision !== expectedRevision) {
      throw new AssemblyPlanValidationError("invalid_input", "Provider provenance revision is not source-bound");
    }
    if (
      provenance.kind !== "world_info"
      && expectedRevision === undefined
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Provider provenance source is not source-bound");
    }
  }
  for (const message of actualBlockMessages) {
    const block = blockByIndex.get(message.blockIndex!);
    if (!block || message.blockId !== block.id || message.role !== (block.role === "user_append" ? "user" : block.role === "assistant_append" ? "assistant" : block.role)) {
      throw new AssemblyPlanValidationError("invalid_input", "Provider block identity is not source-bound");
    }
  }
  const blockMessageByIndex = new Map(actualBlockMessages.map((message) => [message.blockIndex as number, message] as const));
  const rawSegments = (item: InternalBlockPlan): readonly AssemblyMessageSegmentV1[] => {
    const segments: AssemblyMessageSegmentV1[] = [];
    if (item.child) {
      const resultName = item.child.resultName ?? `child_${expectedChildren.findIndex((child) => child.blockIndex === item.blockIndex)}`;
      const slot = expectedSlotByName.get(resultName);
      if (!slot) throw new AssemblyPlanValidationError("missing_result_producer", "Source child has no result slot");
      return frozen([frozen({ kind: "result_slot", slotIndex: slot.slotIndex, resultName: slot.resultName, maxBytes: slot.maxBytes, bytes: 0 })]);
    }
    let cursor = 0;
    for (const reference of item.references) {
      const text = item.block.content.slice(cursor, reference.start);
      if (text.length > 0) segments.push(frozen({ kind: "literal", text, bytes: bytes(text) }));
      const slot = expectedSlotByName.get(reference.resultName);
      if (!slot) throw new AssemblyPlanValidationError("missing_result_producer", "Source reference has no result slot");
      segments.push(frozen({ kind: "result_slot", slotIndex: slot.slotIndex, resultName: slot.resultName, maxBytes: slot.maxBytes, bytes: 0 }));
      cursor = reference.end;
    }
    const tail = item.block.content.slice(cursor);
    if (tail.length > 0) segments.push(frozen({ kind: "literal", text: tail, bytes: bytes(tail) }));
    return frozen(segments);
  };
  const rawComparable = (block: SnapshotBlockV1): boolean => {
    const withoutResults = block.content.replace(/\{\{agentResult::[a-z][a-z0-9_]{0,63}\}\}/g, "");
    const placement = block.role === "user" ? "user_input" : block.role === "assistant" ? "ai_output" : "world_info";
    const structurallyProjected = block.marker !== null
      && Object.hasOwn(snapshot.participants.structuralBlockValues ?? {}, block.id);
    return !structurallyProjected && !withoutResults.includes("{{")
      && !snapshot.regexScripts.some((script) => script.target.includes("prompt") && script.placement.includes(placement))
      && !snapshot.worldInfo.entries.some((entry) => entry.wiMarker !== null && entry.wiMarker.length > 0 && block.content.includes(entry.wiMarker));
  };
  for (const item of selected) {
    const message = blockMessageByIndex.get(item.blockIndex);
    if (!message) continue;
    const expectedSegments = rawSegments(item);
    if (rawComparable(item.block)) {
      if (canonical(message.segments) !== canonical(expectedSegments)) {
        throw new AssemblyPlanValidationError("invalid_input", "Provider literal content is not source-bound");
      }
    } else if (
      message.segments.length !== expectedSegments.length
      || message.segments.some((segment, index) => segment.kind !== expectedSegments[index]!.kind
        || (segment.kind === "result_slot" && canonical(segment) !== canonical(expectedSegments[index])))
    ) {
      throw new AssemblyPlanValidationError("invalid_input", "Provider segment boundaries are not source-bound");
    }
  }
  const expectedOccurrences: AssemblySealV1[] = [];
  for (const blockIndex of sourceBlockOrder) {
    const item = parsed.find((candidate) => candidate.blockIndex === blockIndex);
    if (!item) continue;
    const slotNames = item.child
      ? [item.child.resultName ?? `child_${expectedChildren.findIndex((child) => child.blockIndex === blockIndex)}`]
      : item.references.map((reference) => reference.resultName);
    for (const resultName of slotNames) {
      const slot = expectedSlotByName.get(resultName);
      if (!slot) throw new AssemblyPlanValidationError("missing_result_producer", "Source result reference has no slot");
      expectedOccurrences.push(frozen({
        kind: slot.producerBlockIndex === blockIndex ? "producer" : "consumer",
        resultName: slot.resultName,
        slotIndex: slot.slotIndex,
        blockIndex,
        blockId: blockByIndex.get(blockIndex)!.id,
        sequence: expectedOccurrences.length,
      }));
    }
  }
  if (canonical(plan.seals) !== canonical(expectedOccurrences)) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly result seals are not source-bound");
  }
  const actualActivationPrefix = plan.privateEvidence.activation.slice(0, parsed.length).map((entry) => ({
    blockIndex: entry.blockIndex,
    blockId: entry.blockId,
    hasChild: entry.hasChild,
    referenceCount: entry.referenceCount,
  }));
  const expectedActivationPrefix = parsed.map((item) => ({
    blockIndex: item.blockIndex,
    blockId: item.block.id,
    hasChild: !!item.child,
    referenceCount: item.references.length,
  }));
  if (canonical(actualActivationPrefix) !== canonical(expectedActivationPrefix)) {
    throw new AssemblyPlanValidationError("invalid_input", "Assembly activation evidence is not source-bound");
  }
  const policySections = [
    ["workPolicy", "WORK", phaseRefs.workPolicy, plan.workPolicyMessages],
    ["workspaceUsage", "WORK", phaseRefs.workspaceUsage, plan.workspaceUsageMessages],
    ["completionCriteria", "PREPARE_COMMIT", phaseRefs.completionCriteria, plan.completionCriteriaMessages],
    ["renderPolicy", "RENDER", phaseRefs.renderPolicy, plan.renderPolicyMessages],
  ] as const;
  const expectedCognition: Array<Record<string, unknown>> = [];
  for (const [section, phase, refs, messages] of policySections) {
    if (messages.length !== refs.length) throw new AssemblyPlanValidationError("invalid_input", "Cognition policy message count changed");
    for (let order = 0; order < refs.length; order += 1) {
      const ref = refs[order]!;
      const source = snapshot.agentCognition.cognitionSource;
      const sourceBlock = source?.blocks.find((block) => block.promptOrder === ref.promptOrder);
      const message = messages[order]!;
      if (
        message.blockId !== ref.blockId
        || message.blockIndex !== ref.promptOrder
        || message.segments.some((segment) => segment.kind !== "literal")
        || agentMarkersPresent(message.segments.map((segment) => segment.kind === "literal" ? segment.text : "").join(""))
        || !sourceBlock
        || sourceBlock.blockId !== ref.blockId
      ) throw new AssemblyPlanValidationError("invalid_input", "Cognition policy source binding changed");
      const policyBlock = snapshot.blocks[ref.promptOrder];
      if (!policyBlock || policyBlock.id !== ref.blockId) throw new AssemblyPlanValidationError("invalid_input", "Cognition policy block occurrence is not in the frozen blocks");
      if (rawComparable(policyBlock)) {
        const expectedSegments = [frozen({ kind: "literal" as const, text: policyBlock.content, bytes: bytes(policyBlock.content) })];
        if (canonical(message.segments) !== canonical(expectedSegments)) {
          throw new AssemblyPlanValidationError("invalid_input", "Cognition policy literal content is not source-bound");
        }
      }
      const evidence = plan.privateEvidence.cognition[expectedCognition.length];
      if (!evidence) throw new AssemblyPlanValidationError("invalid_input", "Cognition evidence is incomplete");
      expectedCognition.push({
        kind: "cognition_phase",
        phase,
        section,
        blockId: ref.blockId,
        expectedPresetRevision: ref.expectedPresetRevision,
        expectedBlockRevision: ref.expectedBlockRevision,
        actualPresetRevision: source!.presetRevision,
        actualBlockRevision: sourceBlock.revision,
        order,
        promptOrder: sourceBlock.promptOrder,
        decision: "selected",
        ruleSourceRevision: `${source!.presetRevision}:${sourceBlock.revision}`,
      });
      const actualCore = Object.fromEntries(Object.entries(evidence).filter(([key]) => !["tokenCost", "byteCost"].includes(key)));
      if (canonical(actualCore) !== canonical(expectedCognition.at(-1))) {
        throw new AssemblyPlanValidationError("invalid_input", "Cognition evidence source binding changed");
      }
    }
  }
  if (plan.privateEvidence.cognition.length !== expectedCognition.length) {
    throw new AssemblyPlanValidationError("invalid_input", "Cognition evidence count changed");
  }
}


/**
 * Substitute child output exactly once into direct slots. No macro, regex,
 * callback, or provider path is reachable here; child output is appended as
 * literal bytes and never reparsed.
 */
export function materializeAssemblyPlan(
  plan: AssemblyPlanV1,
  childResults: readonly string[],
  trustedLimits: PreparationLimitsV1,
): readonly AssemblyProviderMessageV1[] {
  validateAssemblyPlanV1(plan, trustedLimits);
  if (childResults.length !== plan.children.length) {
    throw new AssemblyPlanValidationError("invalid_input", "Child result count does not match the reserved batch");
  }
  const output: AssemblyProviderMessageV1[] = [];
  let expansionBytes = 0;
  let assembledInputBytes = 0;
  for (const message of plan.providerMessages) {
    const segments: AssemblyMessageSegmentV1[] = [];
    for (const segment of message.segments) {
      if (segment.kind === "literal") {
        assembledInputBytes += segment.bytes;
        segments.push(frozen({ kind: "literal", text: segment.text, bytes: segment.bytes }));
        continue;
      }
      if (segment.kind === "media") {
        segments.push(frozen({ ...segment }));
        continue;
      }
      const value = childResults[segment.slotIndex];
      if (typeof value !== "string") {
        throw new AssemblyPlanValidationError("invalid_input", "Child result is not textual");
      }
      const valueBytes = bytes(value);
      if (valueBytes > segment.maxBytes) {
        throw new AssemblyPlanValidationError("limit_exceeded", "Child result exceeds its direct slot");
      }
      expansionBytes += valueBytes;
      assembledInputBytes += valueBytes;
      if (expansionBytes > plan.limits.maxCumulativeExpansionBytes || expansionBytes > plan.limits.maxOutputBytes) {
        throw new AssemblyPlanValidationError("limit_exceeded", "Child result expansion exceeds the host limit");
      }
      segments.push(frozen({ kind: "literal", text: value, bytes: valueBytes }));
    }
    if (assembledInputBytes > plan.limits.maxInputBytes) {
      throw new AssemblyPlanValidationError("limit_exceeded", "Materialized assembly exceeds the host input limit");
    }
    output.push(frozen({ ...message, segments: frozen(segments) }));
  }
  return frozen(output);
}

/** Versioned worker operation parser. */
export function parseCompileAgentAssemblyRequest(value: unknown): CompileAgentAssemblyRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssemblyPlanValidationError("invalid_input", "Invalid compile request");
  }
  canonical(value, HOST_PREPARATION_LIMITS_V1.maxInputBytes + HOST_PREPARATION_LIMITS_V1.maxOutputBytes);
  const request = value as Partial<CompileAgentAssemblyRequestV1>;
  const allowedKeys = new Set(["version", "operation", "requestId", "snapshot", "agentConfig"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AssemblyPlanValidationError("invalid_input", "Unknown compile request field");
  }
  if (
    request.version !== 1
    || request.operation !== AGENT_ASSEMBLY_OPERATION
    || typeof request.requestId !== "string"
    || request.requestId.length === 0
    || bytes(request.requestId) > 256
    || !request.snapshot
    || typeof request.snapshot !== "object"
  ) {
    throw new AssemblyPlanValidationError("invalid_input", "Invalid compile request version, identity, or operation");
  }
  return frozen({
    version: 1,
    operation: AGENT_ASSEMBLY_OPERATION,
    requestId: request.requestId,
    snapshot: request.snapshot as GenerationAssemblySnapshotV1,
    agentConfig: request.agentConfig,
  });
}

/** Worker-side entrypoint hook. Snapshot-owned extras only; no DB reads. */
export async function handleCompileAgentAssembly(value: unknown): Promise<AssemblyPlanV1> {
  const request = parseCompileAgentAssemblyRequest(value);
  return compileAgentAssemblyPlan(request);
}

/** Protocol spelling used by subprocess adapters. */
export const compile_agent_assembly = handleCompileAgentAssembly;
