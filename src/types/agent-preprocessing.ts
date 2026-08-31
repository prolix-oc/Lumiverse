/**
 * Closed contracts shared by the host-side preprocessing pipeline and its
 * terminable isolates.  This module deliberately contains data and bounded
 * accounting only; it has no database, provider, extension, or callback
 * dependencies.
 */

import type {
  CognitionPredicateV1,
  LoomPolicyBucketV1,
  LoomPolicyCheckpointV1,
  LoomPolicyDestinationV1,
  LoomPolicySourceV1,
} from "./agent-cognition";
export type PreparationFailureCode =
  | "invalid_input"
  | "limit_exceeded"
  | "queue_full"
  | "worker_disabled"
  | "worker_unavailable"
  | "worker_crashed"
  | "worker_timed_out"
  | "worker_malformed"
  | "cancelled"
  | "requires_response_mode";

/** Host ceilings. Untrusted callers may lower a ceiling, never raise one. */
export interface PreparationLimitsV1 {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxCumulativeExpansionBytes: number;
  readonly maxOperationBytes: number;
  readonly maxPromptBlocks: number;
  readonly maxActiveScripts: number;
  readonly maxCompiledPatterns: number;
  readonly maxMacroResolutions: number;
  readonly maxTrimStrings: number;
  readonly maxCooperativeCpuMs: number;
  readonly maxWallClockMs: number;
  readonly maxWorkers: number;
  readonly maxQueuedJobsPerUser: number;
  readonly maxQueuedJobsProcess: number;
}

const MB = 1024 * 1024;

/** Immutable process defaults for one preprocessing turn. */
export const HOST_PREPARATION_LIMITS_V1: PreparationLimitsV1 = Object.freeze({
  maxInputBytes: 8 * MB,
  maxOutputBytes: 8 * MB,
  maxCumulativeExpansionBytes: 16 * MB,
  maxOperationBytes: 2 * MB,
  maxPromptBlocks: 1024,
  maxActiveScripts: 512,
  maxCompiledPatterns: 1024,
  maxMacroResolutions: 10_000,
  maxTrimStrings: 512,
  maxCooperativeCpuMs: 30_000,
  maxWallClockMs: 60_000,
  maxWorkers: 2,
  maxQueuedJobsPerUser: 4,
  maxQueuedJobsProcess: 32,
});

/** A bounded lower-only override for tests and trusted host policy plumbing. */
export type PreparationLimitsOverrideV1 = Partial<PreparationLimitsV1>;

function finitePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

/**
 * Merge lower-only limits. Invalid values retain the host default; values above
 * a host ceiling are clamped to that ceiling rather than widening the process.
 */
export function lowerPreparationLimitsV1(
  requested?: PreparationLimitsOverrideV1,
): PreparationLimitsV1 {
  const host = HOST_PREPARATION_LIMITS_V1;
  const value = (key: keyof PreparationLimitsV1): number =>
    Math.min(host[key], finitePositiveInteger(requested?.[key], host[key]));
  return Object.freeze({
    maxInputBytes: value("maxInputBytes"),
    maxOutputBytes: value("maxOutputBytes"),
    maxCumulativeExpansionBytes: value("maxCumulativeExpansionBytes"),
    maxOperationBytes: value("maxOperationBytes"),
    maxPromptBlocks: value("maxPromptBlocks"),
    maxActiveScripts: value("maxActiveScripts"),
    maxCompiledPatterns: value("maxCompiledPatterns"),
    maxMacroResolutions: value("maxMacroResolutions"),
    maxTrimStrings: value("maxTrimStrings"),
    maxCooperativeCpuMs: value("maxCooperativeCpuMs"),
    maxWallClockMs: value("maxWallClockMs"),
    maxWorkers: value("maxWorkers"),
    maxQueuedJobsPerUser: value("maxQueuedJobsPerUser"),
    maxQueuedJobsProcess: value("maxQueuedJobsProcess"),
  });
}

export type PreparationBudgetDimensionV1 =
  | "input_bytes"
  | "output_bytes"
  | "cumulative_expansion_bytes"
  | "operation_bytes"
  | "macro_resolutions"
  | "trim_strings";

export class PreparationLimitExceededError extends Error {
  readonly code: PreparationFailureCode = "limit_exceeded";
  readonly dimension: PreparationBudgetDimensionV1;
  readonly limit: number;
  readonly actual: number;

  constructor(dimension: PreparationBudgetDimensionV1, limit: number, actual: number) {
    super(`Preprocessing ${dimension} limit exceeded (${actual} > ${limit})`);
    this.name = "PreparationLimitExceededError";
    this.dimension = dimension;
    this.limit = limit;
    this.actual = actual;
  }
}

export interface ExpansionBudgetSnapshotV1 {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly cumulativeExpansionBytes: number;
  readonly macroResolutions: number;
  readonly trimStrings: number;
}

/**
 * Exact UTF-8 expansion accounting shared by evaluator and built-ins.
 *
 * `preflight*` methods are intentionally side-effect free: a built-in calls
 * them before allocating a generated value, while the evaluator calls
 * `accountExpansion` exactly once after a handler has produced that value.
 * This avoids both post-hoc truncation and double accounting for composed
 * recursive macros.
 */
export interface ExpansionBudgetV1 {
  readonly limits: PreparationLimitsV1;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly cumulativeExpansionBytes: number;
  readonly macroResolutions: number;
  readonly trimStrings: number;
  readonly signal?: AbortSignal;

  reserveInput(value: string | number): void;
  reserveOutputBytes(value: string | number): number;
  reserveExpansionBytes(value: string | number, operationBytes?: number): number;
  preflightOutput(value: string | number): number;
  noteOutput(value: string | number): number;
  preflightExpansion(value: string | number, operationBytes?: number): number;
  accountExpansion(value: string | number, operationBytes?: number): number;
  reserveMacroResolutions(count?: number): void;
  reserveTrimString(count?: number): void;
  checkAbort(): void;
  snapshot(): ExpansionBudgetSnapshotV1;

  /** Safe composition helpers used by built-in expanding primitives. */
  append(parts: readonly string[]): string;
  join(parts: readonly string[], separator: string): string;
  repeat(text: string, count: number): string;
  wrap(prefix: string, text: string, suffix: string): string;
  replaceAll(text: string, find: string, replacement: string): string;
  transform(
    text: string,
    transform: (value: string) => string,
    measureOutputBytes?: (value: string) => number,
  ): string;
}

function exactUtf8Bytes(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Byte count must be a non-negative safe integer");
    }
    return value;
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
type ReplacementTokenV1 =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "match" }
  | { readonly kind: "prefix" }
  | { readonly kind: "suffix" };

function parseReplacementTokens(replacement: string): readonly ReplacementTokenV1[] {
  const tokens: ReplacementTokenV1[] = [];
  let literalStart = 0;
  for (let index = 0; index + 1 < replacement.length; index++) {
    if (replacement[index] !== "$") continue;

    let token: ReplacementTokenV1 | undefined;
    switch (replacement[index + 1]) {
      case "$":
        token = { kind: "literal", value: "$" };
        break;
      case "&":
        token = { kind: "match" };
        break;
      case "`":
        token = { kind: "prefix" };
        break;
      case "'":
        token = { kind: "suffix" };
        break;
    }
    if (!token) continue;

    if (index > literalStart) {
      tokens.push({ kind: "literal", value: replacement.slice(literalStart, index) });
    }
    tokens.push(token);
    index++;
    literalStart = index + 1;
  }
  if (literalStart < replacement.length) {
    tokens.push({ kind: "literal", value: replacement.slice(literalStart) });
  }
  return tokens;
}


class ExpansionBudgetImpl implements ExpansionBudgetV1 {
  readonly limits: PreparationLimitsV1;
  readonly signal?: AbortSignal;
  private _inputBytes = 0;
  private _outputBytes = 0;
  private _cumulativeExpansionBytes = 0;
  private _macroResolutions = 0;
  private _trimStrings = 0;

  constructor(limits: PreparationLimitsV1, signal?: AbortSignal) {
    this.limits = limits;
    this.signal = signal;
  }

  get inputBytes(): number {
    return this._inputBytes;
  }
  get outputBytes(): number {
    return this._outputBytes;
  }
  get cumulativeExpansionBytes(): number {
    return this._cumulativeExpansionBytes;
  }
  get macroResolutions(): number {
    return this._macroResolutions;
  }
  get trimStrings(): number {
    return this._trimStrings;
  }

  reserveInput(value: string | number): void {
    const next = this._inputBytes + exactUtf8Bytes(value);
    if (next > this.limits.maxInputBytes) {
      throw new PreparationLimitExceededError("input_bytes", this.limits.maxInputBytes, next);
    }
    this._inputBytes = next;
  }

  reserveOutputBytes(value: string | number): number {
    return this.preflightOutput(value);
  }

  reserveExpansionBytes(value: string | number, operationBytes?: number): number {
    return this.preflightExpansion(value, operationBytes);
  }

  preflightOutput(value: string | number): number {
    const bytes = exactUtf8Bytes(value);
    if (bytes > this.limits.maxOutputBytes) {
      throw new PreparationLimitExceededError("output_bytes", this.limits.maxOutputBytes, bytes);
    }
    return bytes;
  }

  noteOutput(value: string | number): number {
    const bytes = this.preflightOutput(value);
    this._outputBytes = Math.max(this._outputBytes, bytes);
    return bytes;
  }

  preflightExpansion(value: string | number, operationBytes?: number): number {
    const bytes = exactUtf8Bytes(value);
    const operation = operationBytes === undefined ? bytes : exactUtf8Bytes(operationBytes);
    if (operation > this.limits.maxOperationBytes) {
      throw new PreparationLimitExceededError("operation_bytes", this.limits.maxOperationBytes, operation);
    }
    const next = this._cumulativeExpansionBytes + bytes;
    if (next > this.limits.maxCumulativeExpansionBytes) {
      throw new PreparationLimitExceededError(
        "cumulative_expansion_bytes",
        this.limits.maxCumulativeExpansionBytes,
        next,
      );
    }
    return bytes;
  }

  accountExpansion(value: string | number, operationBytes?: number): number {
    const bytes = this.preflightExpansion(value, operationBytes);
    this._cumulativeExpansionBytes += bytes;
    return bytes;
  }

  reserveMacroResolutions(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Macro resolution count must be a non-negative safe integer");
    if (count > this.limits.maxMacroResolutions - this._macroResolutions) {
      throw new PreparationLimitExceededError("macro_resolutions", this.limits.maxMacroResolutions, this.limits.maxMacroResolutions + 1);
    }
    this._macroResolutions += count;
  }

  reserveTrimString(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Trim count must be a non-negative safe integer");
    if (count > this.limits.maxTrimStrings - this._trimStrings) {
      throw new PreparationLimitExceededError("trim_strings", this.limits.maxTrimStrings, this.limits.maxTrimStrings + 1);
    }
    this._trimStrings += count;
  }


  checkAbort(): void {
    if (this.signal?.aborted) throw this.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  append(parts: readonly string[]): string {
    let bytes = 0;
    for (const part of parts) bytes += exactUtf8Bytes(part);
    this.preflightOutput(bytes);
    this.preflightExpansion(bytes, bytes);
    return parts.join("");
  }

  join(parts: readonly string[], separator: string): string {
    if (parts.length === 0) return "";
    let bytes = exactUtf8Bytes(separator) * (parts.length - 1);
    for (const part of parts) bytes += exactUtf8Bytes(part);
    this.preflightOutput(bytes);
    this.preflightExpansion(bytes, bytes);
    return parts.join(separator);
  }

  repeat(text: string, count: number): string {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Repeat count must be a non-negative safe integer");
    const textBytes = exactUtf8Bytes(text);
    const bytes = textBytes * count;
    if (!Number.isSafeInteger(bytes)) {
      throw new PreparationLimitExceededError("operation_bytes", this.limits.maxOperationBytes, this.limits.maxOperationBytes + 1);
    }
    // Check the hard output ceiling before the per-operation quotient: a
    // repeat whose result can never fit the output budget must surface
    // output_bytes (fail-closed) rather than the construction-scale
    // operation_bytes overage below (skip-worthy).
    this.preflightOutput(bytes);
    if (textBytes > this.limits.maxOperationBytes
      || (textBytes > 0 && count > Math.floor(this.limits.maxOperationBytes / textBytes))) {
      throw new PreparationLimitExceededError("operation_bytes", this.limits.maxOperationBytes, this.limits.maxOperationBytes + 1);
    }
    this.preflightExpansion(bytes, bytes);
    return text.repeat(count);
  }

  wrap(prefix: string, text: string, suffix: string): string {
    const bytes = exactUtf8Bytes(prefix) + exactUtf8Bytes(text) + exactUtf8Bytes(suffix);
    this.preflightOutput(bytes);
    this.preflightExpansion(bytes, bytes);
    return prefix + text + suffix;
  }

  replaceAll(text: string, find: string, replacement: string): string {
    if (!find) return text;

    const tokens = parseReplacementTokens(replacement);
    const chunks: string[] = [];
    let outputBytes = 0;
    const appendChunk = (chunk: string): void => {
      if (!chunk) return;
      const chunkBytes = exactUtf8Bytes(chunk);
      const nextBytes = outputBytes + chunkBytes;
      this.preflightOutput(nextBytes);
      this.preflightExpansion(nextBytes, nextBytes);
      chunks.push(chunk);
      outputBytes = nextBytes;
    };

    let offset = 0;
    while (true) {
      const index = text.indexOf(find, offset);
      if (index < 0) break;

      appendChunk(text.slice(offset, index));
      for (const token of tokens) {
        switch (token.kind) {
          case "literal":
            appendChunk(token.value);
            break;
          case "match":
            appendChunk(find);
            break;
          case "prefix":
            appendChunk(text.slice(0, index));
            break;
          case "suffix":
            appendChunk(text.slice(index + find.length));
            break;
        }
      }
      offset = index + find.length;
    }
    appendChunk(text.slice(offset));

    // The evaluator accounts the completed handler result exactly once.
    return chunks.join("");
  }

  transform(
    text: string,
    transform: (value: string) => string,
    measureOutputBytes?: (value: string) => number,
  ): string {
    // Bound the authored operand before invoking the built-in transform.
    this.preflightExpansion(text, exactUtf8Bytes(text));
    const expectedBytes = measureOutputBytes?.(text);
    if (expectedBytes !== undefined) {
      this.preflightOutput(expectedBytes);
      this.preflightExpansion(expectedBytes);
    }
    const result = transform(text);
    const actualBytes = exactUtf8Bytes(result);
    if (expectedBytes !== undefined && actualBytes !== expectedBytes) {
      throw new TypeError("Preprocessing transform byte measurement mismatch");
    }
    this.preflightOutput(actualBytes);
    this.preflightExpansion(actualBytes);
    return result;
  }

  snapshot(): ExpansionBudgetSnapshotV1 {
    return Object.freeze({
      inputBytes: this._inputBytes,
      outputBytes: this._outputBytes,
      cumulativeExpansionBytes: this._cumulativeExpansionBytes,
      macroResolutions: this._macroResolutions,
      trimStrings: this._trimStrings,
    });
  }
}

export function createExpansionBudget(
  requested?: PreparationLimitsOverrideV1 | PreparationLimitsV1,
  signal?: AbortSignal,
): ExpansionBudgetV1 {
  return new ExpansionBudgetImpl(lowerPreparationLimitsV1(requested), signal);
}

export function utf8ByteLength(value: string): number {
  return exactUtf8Bytes(value);
}

export type PreparationProtocolOperationV1 =
  | "compile_agent_assembly"
  | "prepare_agent_render";

export interface PreparationProtocolEnvelopeV1 {
  readonly version: 1;
  readonly operation: PreparationProtocolOperationV1;
  readonly requestId: string;
}

export const INPUT_REVISION_KINDS_V1 = Object.freeze([
  "target",
  "chat",
  "message",
  "preset",
  "preset_block",
  "config",
  "slot_binding",
  "connection",
  "endpoint",
  "credential",
  "persona",
  "character",
  "group",
  "world_lore",
  "databank",
  "settings",
  "macro_variables",
  "regex",
  "cognition_policy",
  "runtime_epoch",
  "readiness",
] as const);

export type InputRevisionKindV1 = (typeof INPUT_REVISION_KINDS_V1)[number];

/**
 * Host producers retain ordered per-domain projections alongside the canonical
 * `revisions` array. Strict validators accept exactly these derived keys so a
 * new projection cannot smuggle unvalidated data through the isolate boundary.
 */
export const INPUT_REVISION_SET_PROJECTION_KEYS_V1 = Object.freeze([
  "entries",
  "target",
  "chat",
  "messages",
  "preset",
  "blocks",
  "config",
  "slotBinding",
  "connection",
  "endpoint",
  "credential",
  "participants",
  "worldLore",
  "databank",
  "settings",
  "variables",
  "regex",
  "cognition",
  "readiness",
] as const);

export interface InputRevisionV1 {
  readonly kind: InputRevisionKindV1;
  readonly id: string;
  readonly revision: number | string;
  readonly digest: string;
}

export interface InputRevisionSetV1 {
  readonly version: 1;
  readonly revisions: readonly InputRevisionV1[];
  readonly digest: string;
}

export type MacroVariableScopeV1 = "local" | "global" | "chat";
export type MacroVariableOperationV1 = "set" | "delete";

export interface MacroVariableDeltaV1 {
  readonly kind: "macro_variable";
  readonly scope: MacroVariableScopeV1;
  readonly key: string;
  readonly operation: MacroVariableOperationV1;
  readonly value?: string;
  readonly expectedRevision?: number | string;
}

export interface WorldInfoStateDeltaV1 {
  readonly kind: "world_info_state";
  readonly entryId: string;
  readonly operation: "activate" | "deactivate" | "set_cooldown";
  readonly state: "active" | "inactive" | "cooldown";
  /** Exact post-transition state frozen by ASSEMBLE; never inferred at COMMIT. */
  readonly afterState: {
    readonly active: boolean;
    readonly stickyLeft: number;
    readonly cooldownLeft: number;
    readonly delayCount: number;
  };
  readonly expectedRevision?: number | string;
}

export interface SourceMessageDeltaV1 {
  readonly kind: "source_message";
  /** Stable persisted message identity. */
  readonly sourceMessageId: string;
  readonly operation: "create" | "update" | "delete";
  readonly role?: "system" | "user" | "assistant" | "tool";
  readonly content?: string;
  /**
   * Stable zero-based swipe identity captured with the message revision.
   * Strict Agentic updates always carry this field; it remains optional for
   * legacy create/delete callers that do not address a swipe.
   */
  readonly swipeId?: number;
  /** Exact frozen message generation revision required at COMMIT. */
  readonly expectedRevision?: number | string;
}

export interface ChatMetadataDeltaV1 {
  readonly kind: "chat_metadata";
  readonly key: string;
  readonly operation: "set" | "delete";
  readonly value?: string | number | boolean | null;
  readonly expectedRevision?: number | string;
}

export interface RegexActionDeltaV1 {
  readonly kind: "regex_action";
  readonly scriptId: string;
  readonly operation: "apply" | "skip" | "disable";
  readonly expectedRevision?: number | string;
}

export type PreparationDeltaV1 =
  | MacroVariableDeltaV1
  | WorldInfoStateDeltaV1
  | SourceMessageDeltaV1
  | ChatMetadataDeltaV1
  | RegexActionDeltaV1;

export type AssemblyMessageRoleV1 = "system" | "developer" | "user" | "assistant" | "tool";

export interface AssemblyLiteralSegmentV1 {
  readonly kind: "literal";
  readonly text: string;
}

export interface AssemblyResultSlotSegmentV1 {
  readonly kind: "result_slot";
  readonly slotIndex: number;
}

export interface AssemblyMediaSegmentV1 {
  readonly kind: "media";
  readonly mediaType: "image" | "audio";
  readonly mediaId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type AssemblyMessageSegmentV1 =
  | AssemblyLiteralSegmentV1
  | AssemblyResultSlotSegmentV1
  | AssemblyMediaSegmentV1;

export type AssemblyMessageSourceKindV1 = "block" | "history" | "world_info" | "cognition" | "databank";

export interface AssemblyDatabankMessageSourceV1 {
  readonly kind: "automatic" | "mention";
  readonly databankId: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly chunkId: string | null;
  readonly documentContentHash: string | null;
  readonly contentHash: string;
}

export interface AssemblyDatabankMessageProvenanceV1 {
  readonly kind: "automatic" | "mention";
  readonly sources: readonly AssemblyDatabankMessageSourceV1[];
}

export interface AssemblyMessageProvenanceCoreV1 {
  readonly kind: AssemblyMessageSourceKindV1;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceIndex: number;
}

export interface AssemblyLoomMessageProvenanceV1 {
  readonly entryId: string;
  readonly bucket: LoomPolicyBucketV1;
  readonly destination: LoomPolicyDestinationV1;
  readonly checkpoint: LoomPolicyCheckpointV1;
  readonly source: LoomPolicySourceV1;
  readonly condition?: CognitionPredicateV1;
  readonly effectiveText: string;
}

export interface AssemblyOrdinaryMessageProvenanceV1 extends AssemblyMessageProvenanceCoreV1 {
  readonly databank?: AssemblyDatabankMessageProvenanceV1;
  readonly loom?: never;
}

export interface AssemblyCompiledPolicyMessageProvenanceV1 extends AssemblyMessageProvenanceCoreV1 {
  readonly kind: "cognition";
  readonly databank?: never;
  readonly loom: AssemblyLoomMessageProvenanceV1;
}

export type AssemblyMessageProvenanceV1 =
  | AssemblyOrdinaryMessageProvenanceV1
  | AssemblyCompiledPolicyMessageProvenanceV1;

interface AssemblyProviderMessageBaseV1 {
  readonly role: AssemblyMessageRoleV1;
  readonly segments: readonly AssemblyMessageSegmentV1[];
}

export interface AssemblyOrdinaryProviderMessageV1 extends AssemblyProviderMessageBaseV1 {
  /** Required at the strict isolate boundary; optional here for legacy DTO consumers. */
  readonly provenance?: AssemblyOrdinaryMessageProvenanceV1;
  readonly blockIndex?: number;
}

export interface AssemblyCompiledPolicyProviderMessageV1 extends AssemblyProviderMessageBaseV1 {
  readonly provenance: AssemblyCompiledPolicyMessageProvenanceV1;
  readonly blockIndex: number;
}

export type AssemblyProviderMessageV1 =
  | AssemblyOrdinaryProviderMessageV1
  | AssemblyCompiledPolicyProviderMessageV1;

export interface AssemblyResultSlotV1 {
  readonly slotIndex: number;
  readonly maxBytes: number;
  readonly childId: string;
}

export interface AssemblyChildDescriptorV1 {
  readonly childId: string;
  readonly profileId: string;
  readonly task: string;
  readonly slotIndex: number;
  readonly maxOutputBytes: number;
  /** Frozen per-child provider token ceiling from the compiled snapshot. */
  readonly maxOutputTokens: number;
  readonly required: boolean;
  readonly toolIds: readonly string[];
  readonly streamActivity: boolean;
  readonly sourceOffset: number;
}

export interface AssemblyProfileOutputLimitV1 {
  readonly profileId: string;
  readonly maxOutputTokens: number;
}

export interface AssemblyActivationEvidenceV1 {
  readonly kind: "activation";
  readonly profileId: string;
  readonly authorized: boolean;
  readonly tokenCost: number;
}

export interface AssemblyTokenEvidenceV1 {
  readonly kind: "token";
  readonly profileId: string;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
}

export interface AssemblyPlanV1 extends PreparationProtocolEnvelopeV1 {
  readonly operation: "compile_agent_assembly";
  readonly limits: PreparationLimitsV1;
  readonly messages: readonly AssemblyProviderMessageV1[];
  readonly children: readonly AssemblyChildDescriptorV1[];
  readonly resultSlots: readonly AssemblyResultSlotV1[];
  readonly activationEvidence: readonly AssemblyActivationEvidenceV1[];
  readonly tokenEvidence: readonly AssemblyTokenEvidenceV1[];
  /** Per-profile provider ceilings sealed by ASSEMBLE for later dynamic delegation. */
  readonly profileOutputLimits: readonly AssemblyProfileOutputLimitV1[];
  readonly inputRevisions: InputRevisionSetV1;
  /**
   * Phase-owned literal policy messages are kept out of `messages`. The host
   * selects exactly one set for WORK/RENDER; each set is source-sealed and
   * cannot contain result slots or transformed content.
   */
  readonly workPolicyMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  readonly workspaceUsageMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  readonly completionCriteriaMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  readonly renderPolicyMessages: readonly AssemblyCompiledPolicyProviderMessageV1[];
  readonly deltas: readonly PreparationDeltaV1[];
}

export type GenerationTargetKindV1 = "normal" | "continue" | "regenerate" | "swipe";

export interface RenderTargetV1 {
  readonly kind: GenerationTargetKindV1;
  readonly messageId?: number | string;
  readonly swipeId?: number | string;
  readonly branchId?: string;
}

export interface RenderTextPartV1 {
  readonly kind: "text";
  readonly text: string;
}

export interface RenderMediaPartV1 {
  readonly kind: "media";
  readonly mediaKind: "image" | "audio" | "video" | "file";
  readonly mimeType: string;
  readonly reference: string;
  readonly altText?: string;
}

export type RenderContentPartV1 = RenderTextPartV1 | RenderMediaPartV1;

export interface RenderContentV1 {
  readonly kind: "text" | "parts";
  readonly text?: string;
  readonly parts?: readonly RenderContentPartV1[];
}

export interface FrozenSourceMessageV1 {
  /** Stable persisted message identity. */
  readonly sourceMessageId: string;
  /** Exact message generation revision captured by the assembly snapshot. */
  readonly revision: number | string;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: RenderContentV1;
  /** Active zero-based swipe captured with the frozen message. */
  readonly swipeId?: number;
  readonly authorName?: string;
}

export interface FrozenSwipeV1 {
  readonly swipeId: string;
  readonly index: number;
  readonly revision: number | string;
  readonly content: RenderContentV1;
  /**
   * An append slot is a frozen write intent for a new swipe. It carries the
   * target message revision but no existing swipe content.
   */
  readonly slot?: "append";
}

/**
 * Purity of an authored macro dependency declared by ASSEMBLE. Only `pure`
 * dependencies may execute inside the strict render isolate; anything else
 * fails preflight with `requires_response_mode`.
 */
export type RenderMacroPurityV1 = "pure" | "non_pure";
export type RenderMacroDependencySourceV1 = "host" | "preset" | "extension" | "callback";

export interface RenderMacroDependencyV1 {
  readonly name: string;
  readonly purity: RenderMacroPurityV1;
  readonly source: RenderMacroDependencySourceV1;
}

export interface RenderMacroSnapshotV1 {
  readonly local: readonly [string, string][];
  readonly global: readonly [string, string][];
  readonly chat: readonly [string, string][];
  readonly promptVariables: readonly [string, string][];
  /** Authored macro dependencies frozen by ASSEMBLE; absent means none. */
  readonly dependencies?: readonly RenderMacroDependencyV1[];
}

export type FrozenRegexActionTypeV1 = "send" | "append" | "effects";

/**
 * Interactive regex actions are display affordances. The strict render
 * operation never executes them; their presence fails preflight so the turn
 * falls back to Response mode instead of silently dropping them.
 */
export interface FrozenRegexActionV1 {
  readonly id: string;
  readonly type: FrozenRegexActionTypeV1;
}

export interface FrozenRegexScriptV1 {
  readonly scriptId: string;
  readonly revision: number | string;
  readonly pattern: string;
  readonly replacement: string;
  readonly flags: string;
  readonly stage: "prompt" | "response";
  readonly enabled: boolean;
  readonly order: number;
  /** Bounded non-empty literals removed after replacement. */
  readonly trimStrings?: readonly string[];
  readonly actions?: readonly FrozenRegexActionV1[];
}

/** Authored guided-CoT delimiters; absent means the host defaults apply. */
export interface RenderReasoningDelimitersV1 {
  readonly prefix: string;
  readonly suffix: string;
}

export interface RenderFormattingPolicyV1 {
  readonly stripGuidedReasoning: boolean;
  readonly healFormatting: boolean;
  readonly preserveProviderReasoning: boolean;
  readonly reasoningDelimiters?: RenderReasoningDelimitersV1;
}

export interface RenderUsageV1 {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface RenderPreparationInputV1 extends PreparationProtocolEnvelopeV1 {
  readonly operation: "prepare_agent_render";
  readonly limits: PreparationLimitsV1;
  readonly turnId: string;
  readonly target: RenderTargetV1;
  readonly content: RenderContentV1;
  readonly reasoning?: string;
  readonly sourceMessages: readonly FrozenSourceMessageV1[];
  readonly swipes: readonly FrozenSwipeV1[];
  readonly macroSnapshot: RenderMacroSnapshotV1;
  readonly regexScripts: readonly FrozenRegexScriptV1[];
  readonly formatting: RenderFormattingPolicyV1;
  readonly inputRevisions: InputRevisionSetV1;
  readonly deltas: readonly PreparationDeltaV1[];
}

export interface RenderPreparationResultV1 extends PreparationProtocolEnvelopeV1 {
  readonly operation: "prepare_agent_render";
  readonly content: RenderContentV1;
  readonly reasoning?: string;
  readonly usage: RenderUsageV1;
  readonly macroVariableDeltas: readonly MacroVariableDeltaV1[];
  readonly sourceMessageDeltas: readonly SourceMessageDeltaV1[];
  readonly chatMetadataDeltas: readonly ChatMetadataDeltaV1[];
  readonly regexActionDeltas: readonly RegexActionDeltaV1[];
  readonly worldInfoStateDeltas: readonly WorldInfoStateDeltaV1[];
  readonly inputRevisions: InputRevisionSetV1;
}

export function isPreparationFailureCode(value: unknown): value is PreparationFailureCode {
  return typeof value === "string" && [
    "invalid_input",
    "limit_exceeded",
    "queue_full",
    "worker_disabled",
    "worker_unavailable",
    "worker_crashed",
    "worker_timed_out",
    "worker_malformed",
    "cancelled",
    "requires_response_mode",
  ].includes(value);
}

export function isPreparationProtocolEnvelopeV1(value: unknown): value is PreparationProtocolEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && (candidate.operation === "compile_agent_assembly" || candidate.operation === "prepare_agent_render")
    && typeof candidate.requestId === "string"
    && candidate.requestId.length > 0;
}
