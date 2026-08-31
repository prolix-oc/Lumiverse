import { createHash, randomUUID } from "node:crypto";
import type { CouncilSettings } from "lumiverse-spindle-types";
import type { LlmMessage } from "../llm/types";
import {
  executeCouncilForWork,
  WorkCouncilAdmissionError,
  type WorkCouncilConnectionSnapshot,
  type WorkCouncilExecutionInput,
  type WorkCouncilExecutionResult as CouncilExecutionResult,
} from "./council/council-execution.service";
import type {
  RuntimeCouncilToolDefinition,
} from "./council/tool-runtime";
import type { SidecarSettings } from "./sidecar-settings.service";
import type {
  AgentCouncilReceiptV1,
  AgentInspectionCorrelationV1,
  AgentInspectionMarkerV1,
  AgentInspectionProviderIdentityV1,
  AgentInspectionReasonV1,
  AgentInspectionTranscriptRecordV1,
  AgentInspectionUsageV1,
} from "../types/agent-run-projection";
import type { RuntimeRevision } from "../types/agent-runtime-decision";

const MAX_ID_BYTES = 256;
const MAX_TRANSCRIPT_TEXT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 512 * 1024;

export interface WorkCouncilAdmission {
  readonly userId: string;
  readonly chatId: string;
  readonly requestId: string;
  readonly required: boolean;
  readonly settings: CouncilSettings;
  readonly sidecarSettings: SidecarSettings;
  /** Frozen sidecar identity captured by runtime admission. */
  readonly connection?: WorkCouncilConnectionSnapshot | null;
  readonly toolDefinitions: readonly RuntimeCouncilToolDefinition[];
  readonly memberIds?: readonly string[];
  readonly toolNames?: readonly string[];
  readonly connectionRevision?: RuntimeRevision | null;
  readonly correlation: AgentInspectionCorrelationV1;
}

export interface AgenticWorkCouncilInvocation {
  readonly parentFrameId: string;
  readonly messages: readonly LlmMessage[];
  readonly signal: AbortSignal;
}

export interface WorkCouncilExecutionResult {
  readonly advice: string | null;
  readonly receipt: AgentCouncilReceiptV1;
  readonly transcript: readonly AgentInspectionTranscriptRecordV1[];
  readonly usageEvidence: readonly AgentInspectionUsageV1[];
  readonly markers: readonly AgentInspectionMarkerV1[];
}

export interface AgenticWorkCouncilCapability {
  readonly required: boolean;
  /** Frozen provider identity used only for public lifecycle projection. */
  readonly provider?: string | null;
  readonly connectionLabel?: string | null;
  readonly model?: string | null;
  readonly invoke: (input: AgenticWorkCouncilInvocation) => Promise<WorkCouncilExecutionResult>;
}

function boundedText(value: string, maxBytes = MAX_TRANSCRIPT_TEXT_BYTES): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return `${new TextDecoder().decode(bytes.slice(0, maxBytes)).trimEnd()}\n[truncated]`;
}

function boundedId(value: string, label: string): string {
  if (!value || new TextEncoder().encode(value).byteLength > MAX_ID_BYTES) {
    throw new Error(`Invalid Council ${label}`);
  }
  return value;
}

function cloneAndFreeze<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) cloneAndFreeze(item, depth + 1);
    return Object.freeze(value);
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    cloneAndFreeze(child, depth + 1);
  }
  return Object.freeze(value);
}

function snapshot<T>(value: T): T {
  return cloneAndFreeze(structuredClone(value));
}

function digest(value: string | null): string | null {
  if (!value) return null;
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeReason(value: AgentInspectionReasonV1): AgentInspectionReasonV1 {
  return value;
}

function cancellationReason(signal: AbortSignal): AgentInspectionReasonV1 {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return "deadline";
  if (typeof reason === "string" && /deadline|timeout/i.test(reason)) return "deadline";
  return "user_stop";
}

function providerIdentity(result: CouncilExecutionResult | null): AgentInspectionProviderIdentityV1 | null {
  if (!result) return null;
  return {
    adapter: "council-sidecar",
    providerId: result.provider.provider,
    modelId: result.provider.model,
    connectionRevision: result.provider.connectionRevision,
    fingerprint: result.provider.fingerprint,
  };
}

function transcriptRecord(input: {
  readonly id: string;
  readonly kind: AgentInspectionTranscriptRecordV1["kind"];
  readonly actor: AgentInspectionTranscriptRecordV1["actor"];
  readonly recipient: AgentInspectionTranscriptRecordV1["recipient"];
  readonly correlation: AgentInspectionCorrelationV1;
  readonly occurredAt: number;
  readonly durationMs?: number | null;
  readonly content?: string | null;
  readonly arguments?: string | null;
  readonly result?: string | null;
  readonly provider?: AgentInspectionProviderIdentityV1 | null;
  readonly errorReason?: AgentInspectionReasonV1 | null;
}): AgentInspectionTranscriptRecordV1 {
  return Object.freeze({
    version: 1,
    id: input.id,
    kind: input.kind,
    actor: input.actor,
    recipient: input.recipient,
    correlation: input.correlation,
    occurredAt: input.occurredAt,
    durationMs: input.durationMs ?? null,
    late: false,
    content: input.content == null ? null : boundedText(input.content),
    arguments: input.arguments == null ? null : boundedText(input.arguments),
    result: input.result == null ? null : boundedText(input.result),
    provider: input.provider ?? null,
    errorReason: input.errorReason ?? null,
  });
}

function inspectionUsage(
  correlation: AgentInspectionCorrelationV1,
  usage: CouncilExecutionResult["usage"],
): AgentInspectionUsageV1 | null {
  if (usage.requests === 0 && usage.totalTokens === 0) return null;
  return Object.freeze({
    version: 1,
    id: randomUUID(),
    source: usage.totalTokens > 0 ? "provider_reported" : "provisional",
    layer: "council",
    correlation,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    toolCalls: 0,
    childInvocations: 0,
    canonical: false,
  });
}

function omissionMarker(
  correlation: AgentInspectionCorrelationV1,
  required: boolean,
  reason: AgentInspectionReasonV1,
): AgentInspectionMarkerV1 {
  return Object.freeze({
    version: 1,
    id: randomUUID(),
    kind: "unavailable",
    scope: "council",
    correlation,
    firstSequence: null,
    lastSequence: null,
    recoverable: !required,
    detail: reason === "provider_failure"
      ? "Council advisory provider failed"
      : "Council advisory was unavailable",
  });
}

function admissionFailureReason(error: unknown): AgentInspectionReasonV1 {
  if (error instanceof WorkCouncilAdmissionError) {
    if (error.code === "provider_unavailable") return "unavailable";
    if (error.code === "provider_unsupported") return "invalid_input";
    if (error.code === "unauthorized") return "invalid_input";
    return "invalid_input";
  }
  return "provider_failure";
}

function terminalReceipt(input: {
  readonly id: string;
  readonly requestId: string;
  readonly required: boolean;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly state: AgentCouncilReceiptV1["state"];
  readonly memberCount: number;
  readonly resultDigest: string | null;
  readonly correlation: AgentInspectionCorrelationV1;
  readonly reason: AgentInspectionReasonV1;
}): AgentCouncilReceiptV1 {
  return Object.freeze({
    version: 1,
    id: input.id,
    requestId: input.requestId,
    checkpoint: "WORK",
    required: input.required,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    state: input.state,
    memberCount: input.memberCount,
    resultDigest: input.resultDigest,
    correlation: input.correlation,
    reason: safeReason(input.reason),
    canonical: false,
  });
}

function freezeAdmission(input: WorkCouncilAdmission): WorkCouncilAdmission {
  boundedId(input.userId, "user");
  boundedId(input.chatId, "chat");
  boundedId(input.requestId, "request");
  if (typeof input.required !== "boolean") throw new Error("Invalid Council requiredness");
  return snapshot({
    ...input,
    memberIds: input.memberIds ? [...input.memberIds] : undefined,
    toolNames: input.toolNames ? [...input.toolNames] : undefined,
    toolDefinitions: [...input.toolDefinitions],
    settings: input.settings,
    sidecarSettings: input.sidecarSettings,
    ...(input.connection === undefined
      ? {}
      : { connection: input.connection === null ? null : { ...input.connection } }),
    correlation: input.correlation,
  });
}

/** Execute one host-admitted Council operation and return owner-only evidence. */
export async function executeWorkCouncil(
  admissionInput: WorkCouncilAdmission,
  invocation: AgenticWorkCouncilInvocation,
): Promise<WorkCouncilExecutionResult> {
  const admission = freezeAdmission(admissionInput);
  const parentFrameId = boundedId(invocation.parentFrameId, "parent frame");
  const startedAt = Date.now();
  const receiptId = randomUUID();
  const correlation = Object.freeze({
    ...admission.correlation,
    phase: "WORK" as const,
    parentId: parentFrameId,
  });
  const providerResult = { result: null as CouncilExecutionResult | null };
  const transcript: AgentInspectionTranscriptRecordV1[] = [
    transcriptRecord({
      id: randomUUID(),
      kind: "milestone",
      actor: "council",
      recipient: "host",
      correlation,
      occurredAt: startedAt,
      content: "Council advisory admitted for WORK",
      arguments: JSON.stringify({ requestId: admission.requestId, required: admission.required }),
    }),
  ];

  let state: AgentCouncilReceiptV1["state"] = "failed";
  let reason: AgentInspectionReasonV1 = "provider_failure";
  let advice: string | null = null;
  let memberCount = 0;
  let usage: CouncilExecutionResult["usage"] = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
  };

  try {
    if (invocation.signal.aborted) {
      state = "cancelled";
      reason = cancellationReason(invocation.signal);
    } else {
      const messages = snapshot(invocation.messages);
      if (new TextEncoder().encode(JSON.stringify(messages) ?? "null").byteLength > MAX_MESSAGE_BYTES) {
        throw new WorkCouncilAdmissionError("invalid_input", "Council input exceeds the host limit");
      }
      const input: WorkCouncilExecutionInput = {
        userId: admission.userId,
        chatId: admission.chatId,
        settings: admission.settings,
        sidecarSettings: admission.sidecarSettings,
        toolDefinitions: admission.toolDefinitions,
        contextMessages: messages,
        signal: invocation.signal,
        ...(admission.memberIds ? { memberIds: admission.memberIds } : {}),
        ...(admission.toolNames ? { toolNames: admission.toolNames } : {}),
        ...(admission.connection === undefined ? {} : { connection: admission.connection }),
        ...(admission.connectionRevision !== undefined ? { connectionRevision: admission.connectionRevision } : {}),
      };
      const result = await executeCouncilForWork(input);
      providerResult.result = result;
      if (!result) {
        state = "omitted";
        reason = "unavailable";
      } else {
        memberCount = result.memberCount;
        usage = result.usage;
        const successful = result.results.filter((item) => item.success && item.content.trim().length > 0);
        if (successful.length > 0 && result.deliberationBlock.trim().length > 0) {
          state = "accepted";
          reason = "none";
          advice = boundedText(result.deliberationBlock);
        } else {
          state = "failed";
          reason = "provider_failure";
        }
      }
    }
  } catch (error) {
    if (invocation.signal.aborted || (error instanceof WorkCouncilAdmissionError && /cancelled/i.test(error.message))) {
      state = "cancelled";
      reason = cancellationReason(invocation.signal);
    } else {
      state = admission.required ? "failed" : "omitted";
      reason = admissionFailureReason(error);
    }
  }

  const result = providerResult.result;
  const provider = providerIdentity(result);
  if (result) {
    for (const item of result.results) {
      transcript.push(transcriptRecord({
        id: randomUUID(),
        kind: item.success ? "provider_exchange" : "failure",
        actor: "council",
        recipient: "provider",
        correlation,
        occurredAt: startedAt + item.durationMs,
        durationMs: item.durationMs,
        arguments: JSON.stringify({ memberId: item.memberId, toolName: item.toolName }),
        result: item.success ? item.content : null,
        content: item.success ? null : "Council advisory member failed",
        provider,
        ...(item.success ? {} : { errorReason: "provider_failure" as const }),
      }));
    }
  }

  const completedAt = Date.now();
  const receipt = terminalReceipt({
    id: receiptId,
    requestId: admission.requestId,
    required: admission.required,
    startedAt,
    completedAt,
    state,
    memberCount,
    resultDigest: digest(advice),
    correlation,
    reason,
  });
  if (state !== "accepted") {
    transcript.push(transcriptRecord({
      id: randomUUID(),
      kind: "failure",
      actor: "council",
      recipient: "host",
      correlation,
      occurredAt: completedAt,
      content: "Council advisory did not produce root advice",
      errorReason: reason,
    }));
  }
  transcript.push(transcriptRecord({
    id: randomUUID(),
    kind: "terminal",
    actor: "council",
    recipient: "host",
    correlation,
    occurredAt: completedAt,
    durationMs: completedAt - startedAt,
    content: `Council advisory terminal state: ${state}`,
  }));

  const usageEvidence = inspectionUsage(correlation, usage);
  const markers = state === "accepted"
    ? []
    : [omissionMarker(correlation, admission.required, reason)];
  return Object.freeze({
    advice,
    receipt,
    transcript: Object.freeze(transcript),
    usageEvidence: usageEvidence ? Object.freeze([usageEvidence]) : Object.freeze([]),
    markers: Object.freeze(markers),
  });
}

/** Create an immutable capability closure for a reviewed host admission. */
export function createWorkCouncilCapability(
  admission: WorkCouncilAdmission,
): AgenticWorkCouncilCapability {
  const frozen = freezeAdmission(admission);
  return Object.freeze({
    required: frozen.required,
    provider: frozen.connection?.provider ?? null,
    connectionLabel: frozen.connection?.concreteId ?? null,
    model: frozen.connection?.model ?? null,
    invoke: (input: AgenticWorkCouncilInvocation) => executeWorkCouncil(frozen, input),
  });
}
