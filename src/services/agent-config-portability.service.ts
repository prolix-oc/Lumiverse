import { createHash } from "node:crypto";
import { getDb } from "../db/connection";
import type { Database } from "bun:sqlite";
import type {
  AgentCapabilityV1,
  AgentChildWorkspaceCapabilityV1,
  AgentConfigReviewV1,
  AgentConfigStateV1,
  AgentConfigV2,
  AgentConnectionSlotV1,
  AgentProfileConfigV2,
  PortableAgentConfigV1,
} from "../types/agents";
import {
  AGENT_CAPABILITIES,
  AGENT_CHILD_WORKSPACE_CAPABILITIES,
  createDisabledAgentConfigV2,
  parseAgentConfigV2,
  parseAgentRuntimePolicyV1,
  parsePortableAgentConfigV1,
  toPortableAgentConfigV1,
} from "../types/agents";
import type { Preset } from "../types/preset";
import { AgentCognitionValidationError, COGNITION_MAX_BLOCK_REFS_PER_SECTION, COGNITION_MAX_BLOCK_REFS_TOTAL, COGNITION_MAX_ID_BYTES, COGNITION_MAX_LIST_BYTES, COGNITION_MAX_LIST_ITEMS, COGNITION_MAX_PREDICATE_DEPTH, COGNITION_MAX_SOURCE_BLOCKS, type CognitionValidationCode, type LoomPolicySourceV1, type TaskTemplateV1 } from "../types/agent-cognition";
import { parseTaskTemplate } from "./agent-cognition.service";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";
import { resolveConcreteConnectionV1, type ResolvedConcreteConnectionV1 } from "./connections.service";
import * as regexScriptsService from "./regex-scripts.service";
import { REGEX_LIMITS_V1 } from "../utils/regex-limits";
import type { AgentRuntimeHostLimits } from "../types/agent-runtime";
import { canonicalJsonValue, sameJsonValue } from "../utils/json-value";
import { eventBus } from "../ws/bus";
export const AGENT_RUNTIME_RESERVED_PRESET_KEYS = Object.freeze([
  "agent_config",
  "agent_config_revision",
  "agent_config_review",
  "agent_config_review_required",
  "agentConfig",
  "agentConfigRevision",
  "agentConfigReview",
  "agentConfigReviewRequired",
  "portableAgentConfig",
  "portable_agent_config",
  "agentRuntime",
  "agent_runtime",
] as const);
const RESERVED_METADATA_KEYS = new Set<string>(AGENT_RUNTIME_RESERVED_PRESET_KEYS);

export interface PresetAgentSlotBindingV1 {
  slotId: string;
  connectionId: string | null;
  bindingRevision: number;
  state: AgentConfigStateV1;
  reviewCode: string | null;
}

export interface PresetAgentConfigProjection {
  config: AgentConfigV2;
  review: AgentConfigReviewV1;
  configRevision: number;
  /** High-water mark across deleted/recreated slot bindings. */
  bindingRevision: number;
  bindings: PresetAgentSlotBindingV1[];
}

export interface AgentConfigWriteInput {
  config: unknown;
  bindings?: readonly { slotId: string; connectionId: string | null }[];
  expectedConfigRevision?: number;
  review?: Partial<AgentConfigReviewV1>;
  /** Retain an invalid imported cognition payload for authenticated repair. */
  cognitionPolicyOverride?: unknown;
  authoredDraft?: unknown;
}

export interface AgentConfigWriteResult extends PresetAgentConfigProjection {
  presetId: string;
}

export class AgentConfigRevisionConflictError extends Error {
  readonly code = "AGENT_CONFIG_REVISION_CONFLICT" as const;
  readonly presetId: string;
  readonly expectedConfigRevision: number;
  readonly actualConfigRevision: number;

  constructor(presetId: string, expectedConfigRevision: number, actualConfigRevision: number) {
    super(`AGENT_CONFIG_REVISION_CONFLICT: preset ${presetId} changed since config revision ${expectedConfigRevision}; current revision is ${actualConfigRevision}`);
    this.name = "AgentConfigRevisionConflictError";
    this.presetId = presetId;
    this.expectedConfigRevision = expectedConfigRevision;
    this.actualConfigRevision = actualConfigRevision;
  }
}

export interface PortablePresetPayload {
  name: string;
  provider: string;
  engine?: string;
  parameters?: Record<string, unknown>;
  prompt_order?: unknown[];
  prompts?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  agent_config?: unknown;
  regex_scripts?: readonly Record<string, unknown>[];
  regexScripts?: readonly Record<string, unknown>[];
}


/** Wire-only extension: legacy cognition is a bounded inert repair payload. */
export type PortableAgentConfigWireV1 = PortableAgentConfigV1 & {
  cognitionPolicy?: unknown;
};

export interface PortablePresetRuntimeEnvelopeV1 {
  version: 1;
  agentConfig: PortableAgentConfigWireV1 | null;
  taskTemplates: readonly unknown[];
}
export interface PortablePresetImportResult {
  preset: Preset;
  agent_config: AgentConfigV2;
  agent_config_review: AgentConfigReviewV1;
}

export interface PresetDuplicateResult {
  preset: Preset;
  agent_config: AgentConfigV2;
  agent_config_review: AgentConfigReviewV1;
  copiedRegexScriptIds: string[];
}

export interface ChatAgentModeOverride {
  mode: "response" | "agentic" | null;
  revision: number;
  state: AgentConfigStateV1;
  reviewCode: string | null;
  acknowledged: boolean;
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function scrubMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_METADATA_KEYS.has(key)) continue;
    output[key] = entry;
  }
  return output;
}

function parseJsonObject(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(value: unknown, fallback: unknown[] = []): unknown[] {
  if (!Array.isArray(value) && typeof value !== "string") return fallback;
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
const UTF8_ENCODER = new TextEncoder();
export const PORTABLE_JSON_MAX_NODES = 16_384;

function cognitionValidation(
  code: CognitionValidationCode,
  path: string,
  message: string,
): never {
  throw new AgentCognitionValidationError(code, path, message);
}

interface BoundedJsonState {
  bytes: number;
  nodes: number;
  active: WeakSet<object>;
  maxBytes?: number;
  maxItems?: number;
}

function chargePortableJsonNode(state: { nodes: number }, path: string, message: string): void {
  if (state.nodes >= PORTABLE_JSON_MAX_NODES) cognitionValidation("limit_exceeded", path, message);
  state.nodes += 1;
}

function assertPortableJsonChildBudget(
  state: { nodes: number },
  childCount: number,
  path: string,
  message: string,
): void {
  if (childCount > PORTABLE_JSON_MAX_NODES - state.nodes) cognitionValidation("limit_exceeded", path, message);
}

/**
 * Legacy cognition is deliberately not parsed as an executable policy.  It is
 * still validated as a bounded JSON value so a repair row cannot become an
 * unbounded storage or export sink.
 */
function cloneBoundedLegacyJson(
  value: unknown,
  path: string,
  depth = 0,
  state: BoundedJsonState = { bytes: 0, nodes: 0, active: new WeakSet<object>() },
): unknown {
  if (depth > COGNITION_MAX_PREDICATE_DEPTH) {
    return cognitionValidation("limit_exceeded", path, `JSON nesting must be at most ${COGNITION_MAX_PREDICATE_DEPTH}`);
  }
  if (value === null || typeof value === "boolean") {
    chargePortableJsonNode(state, path, `JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);
    return value;
  }
  if (typeof value === "number") {
    chargePortableJsonNode(state, path, `JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);
    if (!Number.isFinite(value)) return cognitionValidation("invalid_value", path, "must be a finite JSON number");
    return value;
  }
  if (typeof value === "string") {
    chargePortableJsonNode(state, path, `JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);
    state.bytes += UTF8_ENCODER.encode(value).byteLength;
    const maxBytes = state.maxBytes ?? COGNITION_MAX_LIST_BYTES;
    if (state.bytes > maxBytes) {
      return cognitionValidation("limit_exceeded", path, `JSON strings must total at most ${maxBytes} UTF-8 bytes`);
    }
    return value;
  }
  if (typeof value !== "object") return cognitionValidation("invalid_type", path, "must be a JSON value");
  if (state.active.has(value)) return cognitionValidation("invalid_value", path, "must not contain a cycle");
  chargePortableJsonNode(state, path, `JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return cognitionValidation("invalid_type", path, "must be a JSON array");
      const maxItems = state.maxItems ?? COGNITION_MAX_LIST_ITEMS;
      if (value.length > maxItems) return cognitionValidation("limit_exceeded", path, `must contain at most ${maxItems} items`);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") return cognitionValidation("invalid_type", path, "must not contain symbol keys");
        if (key === "length") {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !Object.hasOwn(descriptor, "value")) return cognitionValidation("invalid_type", `${path}.length`, "must be a data property");
          continue;
        }
        if (!/^(?:0|[1-9]\d*)$/.test(key)) return cognitionValidation("invalid_type", `${path}.${key}`, "arrays must contain only indexed values");
        const index = Number(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Number.isSafeInteger(index) || index >= value.length || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          return cognitionValidation("invalid_type", `${path}[${key}]`, "must be a present data property");
        }
      }
      assertPortableJsonChildBudget(state, value.length, path, `JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, String(index))) return cognitionValidation("invalid_type", `${path}[${index}]`, "must be present");
        output.push(cloneBoundedLegacyJson(value[index], `${path}[${index}]`, depth + 1, state));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return cognitionValidation("invalid_type", path, "must be a plain JSON object");
    const keys = Reflect.ownKeys(value);
    const maxItems = state.maxItems ?? COGNITION_MAX_LIST_ITEMS;
    if (keys.length > maxItems) return cognitionValidation("limit_exceeded", path, `must contain at most ${maxItems} fields`);
    for (const key of keys) {
      if (typeof key !== "string") return cognitionValidation("invalid_type", path, "must not contain symbol keys");
      state.bytes += UTF8_ENCODER.encode(key).byteLength;
      const maxBytes = state.maxBytes ?? COGNITION_MAX_LIST_BYTES;
      if (state.bytes > maxBytes) {
        return cognitionValidation("limit_exceeded", `${path}.${key}`, `JSON strings must total at most ${maxBytes} UTF-8 bytes`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return cognitionValidation("invalid_type", `${path}.${key}`, "must be an enumerable data property");
      }
    }
    assertPortableJsonChildBudget(state, keys.length, path, `JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: cloneBoundedLegacyJson(descriptor!.value, `${path}.${String(key)}`, depth + 1, state),
        writable: true,
      });
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

function boundedLegacyCognitionPolicy(value: unknown): unknown {
  const cloned = cloneBoundedLegacyJson(value, "agentConfig.cognitionPolicy");
  const serialized = JSON.stringify(cloned);
  if (typeof serialized !== "string") {
    return cognitionValidation("invalid_type", "agentConfig.cognitionPolicy", "must be JSON-serializable");
  }
  if (UTF8_ENCODER.encode(serialized).byteLength > COGNITION_MAX_LIST_BYTES) {
    return cognitionValidation("limit_exceeded", "agentConfig.cognitionPolicy", `JSON must be at most ${COGNITION_MAX_LIST_BYTES} UTF-8 bytes`);
  }
  return cloned;
}

interface PortableAgentConfigIngress {
  config: PortableAgentConfigV1;
  hasLegacyCognition: boolean;
  legacyCognition: unknown;
}

function parsePortableAgentConfigIngress(raw: unknown): PortableAgentConfigIngress {
  const wire = parsePortableWireObject(raw);
  const hasLegacyCognition = Object.hasOwn(wire, "cognitionPolicy");
  if (hasLegacyCognition && Object.hasOwn(wire, "runtimePolicy")) {
    throw new Error("AGENT_RUNTIME_PORTABLE_DUPLICATE_POLICY");
  }
  const legacyCognition = hasLegacyCognition
    ? boundedLegacyCognitionPolicy(wire.cognitionPolicy)
    : undefined;
  const withoutLegacy = { ...wire };
  delete withoutLegacy.cognitionPolicy;
  const config = parsePortableAgentConfigV1(withoutLegacy);
  if (hasLegacyCognition && config.runtimePolicy !== undefined) {
    throw new Error("AGENT_RUNTIME_PORTABLE_DUPLICATE_POLICY");
  }
  return { config, hasLegacyCognition, legacyCognition };
}

function assertPortableGraphArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return cognitionValidation("invalid_type", path, "must be an array");
  }
  if (value.length > COGNITION_MAX_LIST_ITEMS) {
    return cognitionValidation("limit_exceeded", path, `must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) return cognitionValidation("invalid_type", `${path}[${index}]`, "must be present");
  }
  return value;
}

function assertPortableGraphUniqueIds(items: readonly { id: string }[], path: string): void {
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const id = items[index]!.id;
    if (seen.has(id)) cognitionValidation("duplicate_id", `${path}[${index}].id`, `duplicate id ${id}`);
    seen.add(id);
  }
}

function assertPortableGraphDependencies(
  items: readonly { id: string; dependencies?: readonly string[] }[],
  path: string,
): void {
  const known = new Set(items.map((item) => item.id));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 1) cognitionValidation("cycle", `${path}.${id}`, "dependency cycle");
    if (current === 2) return;
    if (!known.has(id)) cognitionValidation("missing_reference", `${path}.${id}`, "dependency references a missing node");
    state.set(id, 1);
    for (const dependency of items.find((item) => item.id === id)?.dependencies ?? []) {
      if (!known.has(dependency)) cognitionValidation("missing_reference", `${path}.${id}`, `missing dependency ${dependency}`);
      visit(dependency);
    }
    state.set(id, 2);
  };
  for (const item of items) visit(item.id);
}

interface PortableGraphStringBudgetState {
  bytes: number;
  nodes: number;
}

function assertPortableGraphStringBudget(
  value: unknown,
  path: string,
  state: PortableGraphStringBudgetState = { bytes: 0, nodes: 0 },
  active = new WeakSet<object>(),
  depth = 0,
): void {
  if (depth > COGNITION_MAX_PREDICATE_DEPTH) cognitionValidation("limit_exceeded", path, `graph nesting must be at most ${COGNITION_MAX_PREDICATE_DEPTH}`);
  if (typeof value === "string") {
    chargePortableJsonNode(state, path, `graph values must total at most ${PORTABLE_JSON_MAX_NODES}`);
    state.bytes += UTF8_ENCODER.encode(value).byteLength;
    if (state.bytes > COGNITION_MAX_LIST_BYTES) cognitionValidation("limit_exceeded", path, `graph strings must total at most ${COGNITION_MAX_LIST_BYTES} UTF-8 bytes`);
    return;
  }
  if (typeof value !== "object" || value === null) {
    chargePortableJsonNode(state, path, `graph values must total at most ${PORTABLE_JSON_MAX_NODES}`);
    return;
  }
  if (active.has(value)) cognitionValidation("invalid_value", path, "must not contain a cycle");
  chargePortableJsonNode(state, path, `graph values must total at most ${PORTABLE_JSON_MAX_NODES}`);
  active.add(value);
  try {
    if (Array.isArray(value) && value.length > COGNITION_MAX_LIST_ITEMS) cognitionValidation("limit_exceeded", path, `must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);
    const entries = Object.entries(value);
    if (!Array.isArray(value) && entries.length > COGNITION_MAX_LIST_ITEMS) cognitionValidation("limit_exceeded", path, `must contain at most ${COGNITION_MAX_LIST_ITEMS} fields`);
    assertPortableJsonChildBudget(state, entries.length, path, `graph values must total at most ${PORTABLE_JSON_MAX_NODES}`);
    for (const [key, entry] of entries) {
      assertPortableGraphStringBudget(entry, `${path}.${key}`, state, active, depth + 1);
    }
  } finally {
    active.delete(value);
  }
}


function parsePortableTaskGraph(
  taskTemplatesValue: unknown,
  config: Pick<PortableAgentConfigV1, "taskPolicy"> | null,
): { taskTemplates: TaskTemplateV1[] } {
  const taskTemplatesRaw = assertPortableGraphArray(taskTemplatesValue, "taskTemplates");
  const graphBudget: PortableGraphStringBudgetState = { bytes: 0, nodes: 1 };
  assertPortableGraphStringBudget(taskTemplatesRaw, "taskTemplates", graphBudget);
  const taskTemplates = taskTemplatesRaw.map((value) => parseTaskTemplate(value));
  assertPortableGraphUniqueIds(taskTemplates, "taskTemplates");
  assertPortableGraphDependencies(taskTemplates, "taskTemplates");

  const taskPolicy = config?.taskPolicy;
  if (taskTemplates.length > 0 && !taskPolicy) {
    cognitionValidation("missing_reference", "agentConfig.taskPolicy", "task templates require a task policy");
  }
  if (taskPolicy) {
    if (taskPolicy.templateIds.length > COGNITION_MAX_LIST_ITEMS) {
      cognitionValidation("limit_exceeded", "agentConfig.taskPolicy.templateIds", `must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);
    }
    const templateIds = new Set(taskTemplates.map((template) => template.id));
    for (const [index, templateId] of taskPolicy.templateIds.entries()) {
      if (!templateIds.has(templateId)) cognitionValidation("missing_reference", `agentConfig.taskPolicy.templateIds[${index}]`, `unknown task template ${templateId}`);
    }
  }
  return { taskTemplates };
}

interface WorkspaceCapabilityProjection {
  capabilities: AgentChildWorkspaceCapabilityV1[];
  repairCode: string | null;
}

/**
 * Read the persisted child grant without downgrading invalid data to no grant.
 * Authored/imported configs are rejected at the V2 parser; this boundary also
 * quarantines malformed rows instead of making a preset unreadable.
 */
function readWorkspaceCapabilities(
  value: unknown,
  path: string,
): WorkspaceCapabilityProjection {
  const invalid = (suffix = ""): WorkspaceCapabilityProjection => ({
    capabilities: [],
    repairCode: `AGENT_RUNTIME_CHILD_WORKSPACE_CAPABILITIES_INVALID:${path}${suffix}`,
  });
  if (value === undefined || value === null) return { capabilities: [], repairCode: null };
  let raw: unknown[];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return invalid();
    }
    if (!Array.isArray(parsed)) return invalid();
    raw = parsed;
  } else {
    return invalid();
  }
  const seen = new Set<AgentChildWorkspaceCapabilityV1>();
  let previousIndex = -1;
  const normalized: AgentChildWorkspaceCapabilityV1[] = [];
  for (const [index, entry] of raw.entries()) {
    const operationIndex = typeof entry === "string"
      ? AGENT_CHILD_WORKSPACE_CAPABILITIES.indexOf(entry as AgentChildWorkspaceCapabilityV1)
      : -1;
    if (operationIndex < 0 || operationIndex <= previousIndex || seen.has(entry as AgentChildWorkspaceCapabilityV1)) {
      return invalid(`[${index}]`);
    }
    seen.add(entry as AgentChildWorkspaceCapabilityV1);
    previousIndex = operationIndex;
    normalized.push(entry as AgentChildWorkspaceCapabilityV1);
  }
  return { capabilities: normalized, repairCode: null };
}

function hasConnectionCapability(
  connection: ResolvedConcreteConnectionV1 | null,
  requirement: AgentCapabilityV1,
): boolean {
  if (!connection) return false;
  if (requirement === "generation") return true;
  const capabilities = connection.capabilities as Readonly<Record<string, unknown>>;
  if (requirement === "streaming") {
    return capabilities.supportsStreaming === true || capabilities.streaming === true;
  }
  if (requirement === "tool_calling") {
    return capabilities.toolCalling === true || capabilities.tool_calling === true || capabilities.supportsToolCalling === true;
  }
  if (requirement === "native_tool_continuation") {
    const mode = capabilities.toolContinuationMode ?? capabilities.tool_continuation_mode;
    if (mode === "native") {
      return (capabilities.nativeToolContinuation === true || capabilities.native_tool_continuation === true)
        && hasConnectionCapability(connection, "tool_calling");
    }
    if (mode === "legacy") return hasConnectionCapability(connection, "tool_calling");
    return false;
  }
  return capabilities.toolsDisabledFinalization === true
    || capabilities.tools_disabled_finalization === true
    || capabilities.supportsToolsDisabledFinalization === true
    || capabilities.supportsToolFinalization === true;
}

interface BindingCapabilityValidation {
  state: AgentConfigStateV1;
  reviewCode: string | null;
}

function validateBindingCapabilities(
  userId: string,
  slot: AgentConnectionSlotV1,
  connectionId: string | null,
  connectionCache: Map<string, ResolvedConcreteConnectionV1 | null>,
): BindingCapabilityValidation {
  if (connectionId === null) return { state: "review_required", reviewCode: "unresolved_slot" };
  const requirements = slot.requiredCapabilities.filter((value): value is AgentCapabilityV1 => (
    (AGENT_CAPABILITIES as readonly string[]).includes(value)
  ));
  if (requirements.length === 0) return { state: "ready", reviewCode: null };

  let connection = connectionCache.get(connectionId);
  if (connection === undefined && !connectionCache.has(connectionId)) {
    try {
      connection = resolveConcreteConnectionV1(userId, connectionId);
    } catch {
      connection = null;
    }
    connectionCache.set(connectionId, connection);
  }
  const missing = requirements.filter((requirement) => !hasConnectionCapability(connection ?? null, requirement));
  return missing.length > 0
    ? { state: "review_required", reviewCode: "capability_mismatch" }
    : { state: "ready", reviewCode: null };
}

function rowReview(
  db: Database,
  userId: string,
  presetId: string,
  state: AgentConfigStateV1,
  reviewCode: string | null,
  reviewAcknowledged = false,
  projectedBindings?: readonly PresetAgentSlotBindingV1[],
): AgentConfigReviewV1 {
  const unresolvedSlotIds = new Set<string>();
  const staleSlotIds = new Set<string>();
  const rows = projectedBindings ?? (
    tableExists(db, "preset_agent_slot_bindings")
      ? db.query("SELECT slot_id, connection_id, binding_revision, state, review_code FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ?").all(userId, presetId) as Array<Record<string, unknown>>
      : []
  );
  for (const row of rows) {
    const slotId = String("slotId" in row ? row.slotId : row.slot_id);
    const rowState = ("state" in row ? row.state : null) as AgentConfigStateV1;
    const rowReviewCode = ("reviewCode" in row ? row.reviewCode : row.review_code) as string | null | undefined;
    if (rowState === "repair_required" || rowReviewCode === "unresolved_slot" || rowReviewCode === "foreign_connection") unresolvedSlotIds.add(slotId);
    else if (rowState === "review_required") staleSlotIds.add(slotId);
  }
  const effectiveState: AgentConfigStateV1 = state === "repair_required"
    ? "repair_required"
    : unresolvedSlotIds.size > 0 || staleSlotIds.size > 0
      ? "review_required"
      : state;
  const effectiveReasonCode = reviewCode
    ?? (rows.some((row) => ("reviewCode" in row ? row.reviewCode : row.review_code) === "capability_mismatch") ? "capability_mismatch" : null);
  return {
    state: effectiveState,
    reasonCode: effectiveReasonCode,
    unresolvedSlotIds: [...unresolvedSlotIds].sort(),
    staleSlotIds: [...staleSlotIds].sort(),
    acknowledged: reviewAcknowledged
      && effectiveState === "ready"
      && unresolvedSlotIds.size === 0
      && staleSlotIds.size === 0,
  };
}


function cognitionReview(_userId: string, _presetId: string, config: AgentConfigV2, source: "local" | "legacy" | "imported" | "foreign", importedReviewRequired = false): { state: AgentConfigStateV1; reasonCode: string | null } {
  const loomPolicy = config.runtimePolicy?.loomPolicy;
  if (loomPolicy === undefined || loomPolicy === null) return { state: "ready", reasonCode: null };
  if (importedReviewRequired || source === "foreign" || source === "imported" || source === "legacy") {
    return { state: "review_required", reasonCode: source === "foreign" ? "foreign_import" : "cognition_import_review_required" };
  }
  return { state: "ready", reasonCode: null };
}

function rowToConfig(row: Record<string, unknown>, profiles: AgentProfileConfigV2[], slots: AgentConnectionSlotV1[]): AgentConfigV2 {
  const configInput: Record<string, unknown> = {
    version: 2,
    agentsEnabled: Number(row.agents_enabled) === 1,
    allowedModes: parseJsonArray(row.allowed_modes, ["response"]),
    defaultMode: row.default_mode === "agentic" ? "agentic" : "response",
    maxInvocations: Number(row.max_invocations) >= 1 ? Number(row.max_invocations) : 64,
    maxToolCalls: Number(row.max_tool_calls) >= 1 ? Number(row.max_tool_calls) : 64,
    mainToolIds: parseJsonArray(row.main_tool_ids),
    mainLoreScope: row.main_lore_scope === "all_owned" ? "all_owned" : "active",
    profiles,
    connectionSlots: slots,
  };
  // phase_policy_json and cognition_policy_json are historical repair
  // carriers. They are never copied into the normalized runtime projection;
  // explicit repair/export paths read the carriers directly.
  const taskPolicy = parseJsonObject(row.task_policy_json);
  const workspacePolicy = parseJsonObject(row.workspace_policy_json);
  const authoredEnvelope = parseJsonObject(row.config_json);
  const authoredConfig = authoredEnvelope.config;
  let authoredRuntimePolicy: unknown;
  let hasCanonicalRuntimePolicy = false;
  if (authoredConfig && typeof authoredConfig === "object" && !Array.isArray(authoredConfig)) {
    authoredRuntimePolicy = (authoredConfig as Record<string, unknown>).runtimePolicy;
    hasCanonicalRuntimePolicy = authoredRuntimePolicy !== undefined;
  }
  if (Object.keys(taskPolicy).length) configInput.taskPolicy = taskPolicy;
  if (Object.keys(workspacePolicy).length) configInput.workspacePolicy = workspacePolicy;
  try {
    if (hasCanonicalRuntimePolicy) configInput.runtimePolicy = parseAgentRuntimePolicyV1(authoredRuntimePolicy);
    return parseAgentConfigV2(configInput);
  } catch (error) {
    if (row.state === "review_required" || row.state === "repair_required") {
      return createDisabledAgentConfigV2();
    }
    throw error;
  }
}
function readNormalizedProjection(db: Database, userId: string, presetId: string): PresetAgentConfigProjection | null {
  if (!tableExists(db, "preset_agent_configs")) return null;
  const row = db.query("SELECT * FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as Record<string, unknown> | null;
  if (!row) return null;
  const profileRows = tableExists(db, "preset_agent_profiles")
    ? db.query("SELECT * FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ? ORDER BY rowid ASC").all(userId, presetId) as Array<Record<string, unknown>>
    : [];
  const slotRows = tableExists(db, "preset_agent_connection_slots")
    ? db.query("SELECT * FROM preset_agent_connection_slots WHERE user_id = ? AND preset_id = ? ORDER BY rowid ASC").all(userId, presetId) as Array<Record<string, unknown>>
    : [];
  const slots: AgentConnectionSlotV1[] = slotRows.map((slot) => ({
    id: String(slot.slot_id),
    label: String(slot.label ?? slot.slot_id),
    requiredCapabilities: parseJsonArray(slot.required_capabilities) as AgentCapabilityV1[],
  }));
  let workspaceCapabilityRepairCode: string | null = null;
  const profiles: AgentProfileConfigV2[] = profileRows.map((profile, index) => {
    const workspaceCapabilities = readWorkspaceCapabilities(
      profile.workspace_capabilities,
      `profiles[${index}].workspaceCapabilities`,
    );
    if (workspaceCapabilityRepairCode === null && workspaceCapabilities.repairCode !== null) {
      workspaceCapabilityRepairCode = workspaceCapabilities.repairCode;
    }
    return {
      id: String(profile.profile_id),
      name: String(profile.name ?? ""),
      systemPrompt: String(profile.system_prompt ?? ""),
      connectionRef: profile.connection_ref_kind === "slot"
        ? { kind: "slot", slotId: String(profile.slot_id) }
        : { kind: "inherit_main" },
      toolIds: parseJsonArray(profile.tool_ids) as AgentProfileConfigV2["toolIds"],
      workspaceCapabilities: workspaceCapabilities.capabilities,
      loreScope: profile.lore_scope === "all_owned" ? "all_owned" : "active",
      allowMainDelegation: Number(profile.allow_main_delegation) === 1,
      failurePolicy: profile.failure_policy === "required" ? "required" : "optional",
      streamActivity: Number(profile.stream_activity) === 1,
      maxOutputTokens: Number(profile.max_output_tokens),
      timeoutMs: Number(profile.timeout_ms),
    };
  });
  const config = workspaceCapabilityRepairCode === null
    ? rowToConfig(row, profiles, slots)
    : createDisabledAgentConfigV2();
  const bindings: PresetAgentSlotBindingV1[] = tableExists(db, "preset_agent_slot_bindings")
    ? (db.query("SELECT slot_id, connection_id, binding_revision, state, review_code FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? ORDER BY slot_id").all(userId, presetId) as Array<Record<string, unknown>>).map((binding) => ({
      slotId: String(binding.slot_id),
      connectionId: binding.connection_id == null ? null : String(binding.connection_id),
      bindingRevision: Number(binding.binding_revision) || 1,
      state: (binding.state === "repair_required" || binding.state === "review_required" ? binding.state : "ready") as AgentConfigStateV1,
      reviewCode: binding.review_code == null ? null : String(binding.review_code),
    }))
    : [];
  const connectionCache = new Map<string, ResolvedConcreteConnectionV1 | null>();
  for (const binding of bindings) {
    if (binding.connectionId === null) continue;
    const slot = slots.find((candidate) => candidate.id === binding.slotId);
    if (!slot) continue;
    const validation = validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache);
    if (validation.reviewCode === "capability_mismatch") {
      // Projection is intentionally live: a provider capability change cannot
      // leave an otherwise-ready binding looking executable until it is saved.
      binding.state = "review_required";
      binding.reviewCode = validation.reviewCode;
    }
  }
  const persistedState = (row.state === "repair_required" || row.state === "review_required" ? row.state : "ready") as AgentConfigStateV1;
  const state: AgentConfigStateV1 = workspaceCapabilityRepairCode === null
    ? persistedState
    : "repair_required";
  const persistedReview = rowReview(
    db,
    userId,
    presetId,
    state,
    workspaceCapabilityRepairCode ?? (row.review_code == null ? null : String(row.review_code)),
    Number(row.review_acknowledged) === 1,
    bindings,
  );
  const cognition = cognitionReview(
    userId,
    presetId,
    config,
    state === "review_required" ? "foreign" : "local",
    state === "review_required",
  );
  let review = cognition.state === "ready"
    ? persistedReview
    : {
      ...persistedReview,
      state: cognition.state,
      reasonCode: persistedReview.reasonCode != null && STICKY_IMPORT_REVIEW_REASON_CODES[persistedReview.reasonCode] === true
        ? persistedReview.reasonCode
        : cognition.reasonCode,
      acknowledged: false,
    };
  return {
    config,
    review,
    configRevision: Number(row.config_revision) || 1,
    bindingRevision: Number(row.binding_revision) || Math.max(1, ...bindings.map((binding) => binding.bindingRevision)),
    bindings,
  };
}

export function getPresetAgentConfig(userId: string, presetId: string): PresetAgentConfigProjection | null {
  const db = getDb();
  // Only the normalized V2 projection has executable authority. Missing rows
  // remain inert.
  return readNormalizedProjection(db, userId, presetId);
}


function assertPresetOwned(db: Database, userId: string, presetId: string): Record<string, unknown> {
  const row = db.query("SELECT * FROM presets WHERE id = ? AND user_id = ?").get(presetId, userId) as Record<string, unknown> | null;
  if (!row) throw new Error("Preset not found");
  return row;
}
interface PreparedWriteConfig {
  config: AgentConfigV2;
}

export type AgentConfigWritePreparation = PreparedWriteConfig;

export function preparePresetAgentConfigForWrite(raw: unknown): AgentConfigWritePreparation {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.hasOwn(raw, "portableVersion")) {
    const portable = parsePortableAgentConfigV1(raw);
    const { portableVersion: _portableVersion, ...authored } = portable;
    return { config: parseAgentConfigV2({ ...authored, version: 2 }) };
  }
  return { config: parseAgentConfigV2(raw) };
}
function writeAgentConfigWithDb(
  db: Database,
  userId: string,
  presetId: string,
  input: AgentConfigWriteInput,
  preparedOverride?: AgentConfigWritePreparation,
): AgentConfigWriteResult {
  const presetRow = assertPresetOwned(db, userId, presetId);
  const current = readNormalizedProjection(db, userId, presetId);
  const currentConfigRevision = current?.configRevision ?? 0;
  if (input.expectedConfigRevision !== undefined && input.expectedConfigRevision !== currentConfigRevision) {
    throw new AgentConfigRevisionConflictError(presetId, input.expectedConfigRevision, currentConfigRevision);
  }
  if (input.expectedConfigRevision !== undefined && current !== null) {
    const fence = db.query(
      "UPDATE preset_agent_configs SET config_revision = config_revision WHERE user_id = ? AND preset_id = ? AND config_revision = ?",
    ).run(userId, presetId, currentConfigRevision);
    if (fence.changes !== 1) {
      const row = db.query("SELECT config_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_revision?: unknown } | null;
      const actualConfigRevision = Number(row?.config_revision) || 0;
      throw new AgentConfigRevisionConflictError(presetId, input.expectedConfigRevision, actualConfigRevision);
    }
  }
  const prepared = preparedOverride ?? preparePresetAgentConfigForWrite(input.config);
  const config = prepared.config;
  const presetRevision = Number(presetRow.cache_revision) || 0;
  const promptOrder = parseJsonArray(presetRow.prompt_order);
  const loomReferenceRepairRequired = !loomReferencesMatchPromptOrder(config, presetRevision, promptOrder);
  const persistedBindings = current?.bindings
    .filter((binding) => config.connectionSlots.some((slot) => slot.id === binding.slotId))
    .map((binding) => ({ slotId: binding.slotId, connectionId: binding.connectionId })) ?? [];
  const previousBindingRevisions = new Map((current?.bindings ?? []).map((binding) => [binding.slotId, binding.bindingRevision]));
  let bindingRevisionHighWater = Math.max(1, current?.bindingRevision ?? 0, currentConfigRevision, ...previousBindingRevisions.values());
  const bindings = [...(input.bindings ?? persistedBindings)];
  for (const slot of config.connectionSlots) {
    if (!bindings.some((binding) => binding.slotId === slot.id)) bindings.push({ slotId: slot.id, connectionId: null });
  }
  for (const slotId of input.review?.unresolvedSlotIds ?? []) {
    if (!bindings.some((binding) => binding.slotId === slotId)) bindings.push({ slotId, connectionId: null });
  }
  const connectionCache = new Map<string, ResolvedConcreteConnectionV1 | null>();
  const bindingValidation = new Map<string, BindingCapabilityValidation>();
  for (const binding of bindings) {
    const slot = config.connectionSlots.find((candidate) => candidate.id === binding.slotId);
    if (slot) bindingValidation.set(binding.slotId, validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache));
  }
  const hasCapabilityMismatch = [...bindingValidation.values()].some((validation) => validation.reviewCode === "capability_mismatch");
  const replacementCognition = cognitionReview(userId, presetId, config, "local", false);
  const inheritedRepairRequired = (current?.review.state === "repair_required" || input.review?.state === "repair_required")
    && replacementCognition.state !== "ready";
  const requestedReviewState = input.review?.state ?? "ready";
  const cognition = cognitionReview(userId, presetId, config, requestedReviewState === "review_required" ? "foreign" : "local", requestedReviewState === "review_required");
  const reviewState = loomReferenceRepairRequired
    ? "repair_required"
    : cognition.state === "ready"
      ? inheritedRepairRequired
        ? "repair_required"
        : hasCapabilityMismatch
          ? "review_required"
          : requestedReviewState
      : cognition.state;
  let reviewCode: string | null = loomReferenceRepairRequired
    ? "loom_reference_repair_required"
    : cognition.reasonCode;
  if (
    !loomReferenceRepairRequired
    && requestedReviewState === "review_required"
    && input.review?.reasonCode != null
    && STICKY_IMPORT_REVIEW_REASON_CODES[input.review.reasonCode] === true
  ) {
    reviewCode = input.review.reasonCode;
  } else if (!loomReferenceRepairRequired) {
    if (reviewCode === null && inheritedRepairRequired) {
      reviewCode = current?.review.reasonCode ?? input.review?.reasonCode ?? null;
    }
    if (reviewCode === null && hasCapabilityMismatch) reviewCode = "capability_mismatch";
    if (reviewCode === null) reviewCode = input.review?.reasonCode ?? null;
  }
  const now = Math.floor(Date.now() / 1000);
  const nextRevision = currentConfigRevision + 1;
  let authoredEnvelope: Record<string, unknown> = { config };
  if (input.authoredDraft !== undefined) {
    if (typeof input.authoredDraft !== "object" || input.authoredDraft === null || Array.isArray(input.authoredDraft)) {
      throw new Error("AGENT_RUNTIME_AUTHORED_INVALID");
    }
    authoredEnvelope = { ...(input.authoredDraft as Record<string, unknown>), config };
  } else {
    const previousRow = tableExists(db, "preset_agent_configs")
      ? db.query("SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_json?: unknown } | null
      : null;
    const previousEnvelope = parseJsonObject(previousRow?.config_json);
    if (Object.keys(previousEnvelope).length > 0) authoredEnvelope = { ...previousEnvelope, config };
  }
  if (input.cognitionPolicyOverride !== undefined) {
    input = { ...input, cognitionPolicyOverride: boundedLegacyCognitionPolicy(input.cognitionPolicyOverride) };
  }
  const cognitionPolicyJson = input.cognitionPolicyOverride === undefined
    ? "{}"
    : JSON.stringify(input.cognitionPolicyOverride);
  if (typeof cognitionPolicyJson !== "string") throw new Error("AGENT_RUNTIME_COGNITION_INVALID");
  db.query(`INSERT INTO preset_agent_configs (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode, max_invocations, max_tool_calls, main_tool_ids, main_lore_scope, phase_policy_json, cognition_policy_json, task_policy_json, workspace_policy_json, config_json, state, review_code, review_acknowledged, config_revision, binding_revision, created_at, updated_at) VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, preset_id) DO UPDATE SET agents_enabled = excluded.agents_enabled, allowed_modes = excluded.allowed_modes, default_mode = excluded.default_mode, max_invocations = excluded.max_invocations, max_tool_calls = excluded.max_tool_calls, main_tool_ids = excluded.main_tool_ids, main_lore_scope = excluded.main_lore_scope, phase_policy_json = excluded.phase_policy_json, cognition_policy_json = excluded.cognition_policy_json, task_policy_json = excluded.task_policy_json, workspace_policy_json = excluded.workspace_policy_json, config_json = excluded.config_json, state = excluded.state, review_code = excluded.review_code, review_acknowledged = excluded.review_acknowledged, config_revision = excluded.config_revision, binding_revision = excluded.binding_revision, updated_at = excluded.updated_at`).run(userId, presetId, config.agentsEnabled ? 1 : 0, JSON.stringify(config.allowedModes), config.defaultMode, config.maxInvocations, config.maxToolCalls, JSON.stringify(config.mainToolIds), config.mainLoreScope, JSON.stringify({}), cognitionPolicyJson, JSON.stringify(config.taskPolicy ?? {}), JSON.stringify(config.workspacePolicy ?? {}), JSON.stringify(authoredEnvelope), reviewState, reviewCode, input.review?.acknowledged ? 1 : 0, nextRevision, bindingRevisionHighWater, now, now);
  db.query("DELETE FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ?").run(userId, presetId);
  db.query("DELETE FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ?").run(userId, presetId);
  db.query("DELETE FROM preset_agent_connection_slots WHERE user_id = ? AND preset_id = ?").run(userId, presetId);
  for (const slot of config.connectionSlots) db.query("INSERT INTO preset_agent_connection_slots (user_id, preset_id, slot_id, label, required_capabilities, slot_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(userId, presetId, slot.id, slot.label, JSON.stringify(slot.requiredCapabilities), now, now);
  for (const profile of config.profiles) db.query("INSERT INTO preset_agent_profiles (user_id, preset_id, profile_id, name, system_prompt, connection_ref_kind, slot_id, tool_ids, workspace_capabilities, lore_scope, allow_main_delegation, failure_policy, stream_activity, max_output_tokens, timeout_ms, profile_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").run(userId, presetId, profile.id, profile.name, profile.systemPrompt, profile.connectionRef.kind, profile.connectionRef.kind === "slot" ? profile.connectionRef.slotId : null, JSON.stringify(profile.toolIds), JSON.stringify(profile.workspaceCapabilities ?? []), profile.loreScope, profile.allowMainDelegation ? 1 : 0, profile.failurePolicy, profile.streamActivity ? 1 : 0, profile.maxOutputTokens, profile.timeoutMs, now, now);
  for (const binding of bindings) {
    const slot = config.connectionSlots.find((candidate) => candidate.id === binding.slotId);
    if (!slot) throw new Error(`Unknown agent connection slot: ${binding.slotId}`);
    if (binding.connectionId !== null && !db.query("SELECT 1 FROM connection_profiles WHERE user_id = ? AND id = ?").get(userId, binding.connectionId)) throw new Error("Agent connection binding is not owned by this user");
    const bindingRevision = ++bindingRevisionHighWater;
    const validation = bindingValidation.get(binding.slotId) ?? validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache);
    const bindingState = validation.state;
    const bindingReviewCode = validation.reviewCode;
    db.query("INSERT INTO preset_agent_slot_bindings (user_id, preset_id, slot_id, connection_id, binding_revision, state, review_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(userId, presetId, binding.slotId, binding.connectionId, bindingRevision, bindingState, bindingReviewCode, now);
  }
  if (bindingRevisionHighWater !== Number(current?.bindingRevision ?? 0)) {
    db.query("UPDATE preset_agent_configs SET binding_revision = ? WHERE user_id = ? AND preset_id = ?").run(bindingRevisionHighWater, userId, presetId);
  }
  const projection = readNormalizedProjection(db, userId, presetId);
  if (!projection) throw new Error("Agent config write did not produce a projection");
  return { ...projection, presetId };
}
export function writePresetAgentConfigWithDb(
  db: Database,
  userId: string,
  presetId: string,
  input: AgentConfigWriteInput,
  preparedOverride?: AgentConfigWritePreparation,
): AgentConfigWriteResult {
  return writeAgentConfigWithDb(db, userId, presetId, input, preparedOverride);
}

export function writePresetAgentConfig(userId: string, presetId: string, input: AgentConfigWriteInput): AgentConfigWriteResult {
  const db = getDb(); return db.transaction(() => writeAgentConfigWithDb(db, userId, presetId, input))();
}

export function encodePortableAgentConfig(config: AgentConfigV2): string { return JSON.stringify(toPortableAgentConfigV1(config)); }


function assertExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...expected, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${path} contains unknown or missing fields`);
  }
}


interface PersistedLegacyCognitionPolicy {
  value: unknown;
}

function readPersistedLegacyCognitionPolicy(
  db: Database,
  userId: string,
  presetId: string,
  projection: PresetAgentConfigProjection,
): PersistedLegacyCognitionPolicy | null {
  const row = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT cognition_policy_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { cognition_policy_json?: unknown } | null
    : null;
  const raw = row?.cognition_policy_json;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (raw.trim() === "{}" && projection.review.reasonCode !== "cognition_invalid") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cognitionValidation("invalid_type", "agentConfig.cognitionPolicy", "stored legacy cognition is not valid JSON");
  }
  return { value: boundedLegacyCognitionPolicy(parsed) };
}


export function getPortablePresetRuntimeEnvelope(userId: string, presetId: string): PortablePresetRuntimeEnvelopeV1 | null {
  const db = getDb();
  const projection = getPresetAgentConfig(userId, presetId);
  if (!projection) return null;
  const source = readAuthoredCognitionSource(db, userId, presetId, projection, { allowQuarantined: true });
  const persistedLegacy = readPersistedLegacyCognitionPolicy(db, userId, presetId, projection);
  const baseAuthored: PortableAgentConfigWireV1 = toPortableAgentConfigV1(projection.config);
  const agentConfig: PortableAgentConfigWireV1 = persistedLegacy
    ? { ...baseAuthored, cognitionPolicy: persistedLegacy.value }
    : baseAuthored;
  if (persistedLegacy && Object.hasOwn(agentConfig, "runtimePolicy")) {
    throw new Error("AGENT_RUNTIME_PORTABLE_DUPLICATE_POLICY");
  }
  return {
    version: 1,
    agentConfig,
    taskTemplates: source?.taskTemplates ?? [],
  };
}

export function parsePortablePresetRuntimeEnvelope(raw: unknown): PortablePresetRuntimeEnvelopeV1 {
  const object = parsePortableWireObject(raw);
  assertExactObjectKeys(object, ["version", "agentConfig", "taskTemplates"], "agentRuntime");
  if (object.version !== 1) throw new Error("AGENT_RUNTIME_PORTABLE_VERSION_UNSUPPORTED");
  const rawAgentConfig = object.agentConfig;
  const configIngress = rawAgentConfig === null ? null : parsePortableAgentConfigIngress(rawAgentConfig);
  const agentConfig: PortableAgentConfigWireV1 | null = configIngress === null
    ? null
    : configIngress.hasLegacyCognition
      ? { ...configIngress.config, cognitionPolicy: configIngress.legacyCognition }
      : configIngress.config;
  if (!Array.isArray(object.taskTemplates)) throw new Error("AGENT_RUNTIME_PORTABLE_INVALID");
  const graph = parsePortableTaskGraph(object.taskTemplates, agentConfig);
  return {
    version: 1,
    agentConfig,
    taskTemplates: graph.taskTemplates,
  };
}
function parsePortableWireObject(raw: unknown): Record<string, unknown> {
  if (raw instanceof Uint8Array) raw = new TextDecoder().decode(raw);
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { throw new Error("PORTABLE_AGENT_CONFIG_INVALID"); }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error("PORTABLE_AGENT_CONFIG_INVALID");
  return raw as Record<string, unknown>;
}

export const PORTABLE_PRESET_FIELDS_MAX_BYTES = 2 * 1024 * 1024;
export const PORTABLE_REGEX_FIELDS_MAX_BYTES = 4 * 1024 * 1024;

const PORTABLE_PROMPT_BLOCK_KEYS: Record<string, true> = {
  id: true,
  name: true,
  content: true,
  role: true,
  enabled: true,
  position: true,
  depth: true,
  marker: true,
  isLocked: true,
  color: true,
  injectionTrigger: true,
  characterTagTrigger: true,
  group: true,
  categoryMode: true,
  savedChildEnabled: true,
  variables: true,
  placementBinding: true,
  stashId: true,
  sealed: true,
  sealedKey: true,
  sealedSource: true,
  sealedOriginPresetId: true,
  sealedOriginVersion: true,
  sealedSha256: true,
  order: true,
  revision: true,
};

function isPortablePromptRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function assertPortablePromptStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return cognitionValidation("invalid_type", path, "must be an array of strings");
  }
}

function assertPortablePromptText(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") return cognitionValidation("invalid_type", path, "must be a string");
}

function assertPortablePromptNonEmptyText(value: unknown, path: string): asserts value is string {
  assertPortablePromptText(value, path);
  if (value.trim().length === 0) return cognitionValidation("invalid_value", path, "must not be empty");
}

const PORTABLE_PROMPT_VARIABLE_OPTION_KEYS: Record<string, true> = { id: true, label: true, value: true };
const PORTABLE_PROMPT_PLACEMENT_KEYS: Record<string, true> = { role: true, position: true, depth: true };
const PORTABLE_PROMPT_BINDING_KEYS: Record<string, true> = { variableId: true, options: true };

function assertPortablePromptKnownKeys(
  value: Record<string, unknown>,
  allowed: Readonly<Record<string, true>>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) cognitionValidation("invalid_type", `${path}.${key}`, "unknown nested prompt field");
  }
}

function assertPortablePromptFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return cognitionValidation("invalid_type", path, "must be a finite number");
  }
  return value;
}


function assertPortablePromptVariableOption(value: unknown, path: string): void {
  if (!isPortablePromptRecord(value)) {
    return cognitionValidation("invalid_type", path, "must be a plain object");
  }
  assertPortablePromptKnownKeys(value, PORTABLE_PROMPT_VARIABLE_OPTION_KEYS, path);
  assertPortablePromptNonEmptyText(value.id, `${path}.id`);
  assertPortablePromptText(value.label, `${path}.label`);
  assertPortablePromptText(value.value, `${path}.value`);
}


function assertPortablePromptPlacement(value: unknown, path: string): void {
  if (!isPortablePromptRecord(value)) {
    return cognitionValidation("invalid_type", path, "must be a plain object");
  }
  assertPortablePromptKnownKeys(value, PORTABLE_PROMPT_PLACEMENT_KEYS, path);
  if (!["system", "user", "assistant", "user_append", "assistant_append"].includes(String(value.role))) {
    return cognitionValidation("invalid_value", `${path}.role`, "invalid prompt placement role");
  }
  if (!["pre_history", "post_history", "in_history"].includes(String(value.position))) {
    return cognitionValidation("invalid_value", `${path}.position`, "invalid prompt placement position");
  }
  assertPortablePromptFiniteNumber(value.depth, `${path}.depth`);
  if (Number(value.depth) < 0) {
    return cognitionValidation("invalid_value", `${path}.depth`, "must be non-negative");
  }
}

function assertPortablePromptPlacementBinding(value: unknown, path: string): void {
  if (!isPortablePromptRecord(value)) {
    return cognitionValidation("invalid_type", path, "must be a plain object");
  }
  assertPortablePromptKnownKeys(value, PORTABLE_PROMPT_BINDING_KEYS, path);
  assertPortablePromptNonEmptyText(value.variableId, `${path}.variableId`);
  if (!isPortablePromptRecord(value.options)) {
    return cognitionValidation("invalid_type", `${path}.options`, "must be a plain object");
  }
  for (const [optionId, placement] of Object.entries(value.options)) {
    if (!optionId) return cognitionValidation("invalid_value", `${path}.options`, "option ids must be non-empty");
    assertPortablePromptPlacement(placement, `${path}.options.${optionId}`);
  }
}

function assertPortablePromptVariable(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isPortablePromptRecord(value)) {
    return cognitionValidation("invalid_type", path, "must be a prompt variable object");
  }
  const type = value.type;
  if (
    type !== "text"
    && type !== "textarea"
    && type !== "number"
    && type !== "slider"
    && type !== "select"
    && type !== "switch"
    && type !== "multiselect"
  ) {
    return cognitionValidation("invalid_value", `${path}.type`, "invalid prompt variable type");
  }

  const allowed: Record<string, true> = {
    id: true,
    name: true,
    label: true,
    type: true,
    defaultValue: true,
    description: true,
  };
  if (type === "textarea") allowed.rows = true;
  if (type === "number" || type === "slider") {
    allowed.min = true;
    allowed.max = true;
    allowed.step = true;
  }
  if (type === "select" || type === "multiselect") allowed.options = true;
  if (type === "multiselect") allowed.separator = true;
  assertPortablePromptKnownKeys(value, allowed, path);

  assertPortablePromptNonEmptyText(value.id, `${path}.id`);
  assertPortablePromptNonEmptyText(value.name, `${path}.name`);
  assertPortablePromptText(value.label, `${path}.label`);
  if (value.description !== undefined) assertPortablePromptText(value.description, `${path}.description`);

  switch (type) {
    case "text":
      return assertPortablePromptText(value.defaultValue, `${path}.defaultValue`);
    case "textarea":
      assertPortablePromptText(value.defaultValue, `${path}.defaultValue`);
      if (value.rows !== undefined) {
        const rows = assertPortablePromptFiniteNumber(value.rows, `${path}.rows`);
        if (!Number.isInteger(rows) || rows < 1) return cognitionValidation("invalid_value", `${path}.rows`, "must be a positive integer");
      }
      return;
    case "number":
    case "slider": {
      const defaultValue = assertPortablePromptFiniteNumber(value.defaultValue, `${path}.defaultValue`);
      const min = value.min === undefined ? undefined : assertPortablePromptFiniteNumber(value.min, `${path}.min`);
      const max = value.max === undefined ? undefined : assertPortablePromptFiniteNumber(value.max, `${path}.max`);
      if (type === "slider" && (min === undefined || max === undefined)) {
        return cognitionValidation("invalid_type", path, "slider variables require min and max");
      }
      if (min !== undefined && max !== undefined && min > max) {
        return cognitionValidation("invalid_value", path, "variable minimum must not exceed maximum");
      }
      if ((min !== undefined && defaultValue < min) || (max !== undefined && defaultValue > max)) {
        return cognitionValidation("invalid_value", `${path}.defaultValue`, "must be within the variable range");
      }
      if (value.step !== undefined) {
        const step = assertPortablePromptFiniteNumber(value.step, `${path}.step`);
        if (step <= 0) return cognitionValidation("invalid_value", `${path}.step`, "must be positive");
      }
      return;
    }
    case "switch":
      if (value.defaultValue !== 0 && value.defaultValue !== 1) {
        return cognitionValidation("invalid_value", `${path}.defaultValue`, "switch default must be 0 or 1");
      }
      return;
    case "select":
    case "multiselect": {
      if (!Array.isArray(value.options)) {
        return cognitionValidation("invalid_type", `${path}.options`, "must be an array");
      }
      if (value.options.length === 0) {
        return cognitionValidation("invalid_value", `${path}.options`, "must contain at least one option");
      }
      if (value.options.length > COGNITION_MAX_LIST_ITEMS) {
        return cognitionValidation("limit_exceeded", `${path}.options`, `must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);
      }
      const optionIds = new Set<string>();
      for (const [index, option] of value.options.entries()) {
        assertPortablePromptVariableOption(option, `${path}.options[${index}]`);
        const optionId = (option as Record<string, unknown>).id as string;
        if (optionIds.has(optionId)) {
          return cognitionValidation("invalid_value", `${path}.options`, "must not contain duplicate option ids");
        }
        optionIds.add(optionId);
      }
      if (type === "select") {
        assertPortablePromptText(value.defaultValue, `${path}.defaultValue`);
        const defaultValue = value.defaultValue as string;
        if (!optionIds.has(defaultValue)) return cognitionValidation("invalid_value", `${path}.defaultValue`, "must match an option id");
      } else {
        if (!Array.isArray(value.defaultValue)) {
          return cognitionValidation("invalid_type", `${path}.defaultValue`, "must be an array of strings");
        }
        const defaults = new Set<string>();
        for (const [index, selectedId] of value.defaultValue.entries()) {
          assertPortablePromptText(selectedId, `${path}.defaultValue[${index}]`);
          const id = selectedId as string;
          if (defaults.has(id)) return cognitionValidation("invalid_value", `${path}.defaultValue`, "must not contain duplicate option ids");
          if (!optionIds.has(id)) return cognitionValidation("invalid_value", `${path}.defaultValue`, "must match an option id");
          defaults.add(id);
        }
        if (value.separator !== undefined) assertPortablePromptText(value.separator, `${path}.separator`);
      }
      return;
    }
  }
}

function assertPortablePromptVariableState(value: unknown, path: string): void {
  if (!isPortablePromptRecord(value)) {
    return cognitionValidation("invalid_type", path, "must be a plain object");
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof key !== "string" || typeof enabled !== "boolean") {
      return cognitionValidation("invalid_type", `${path}.${key}`, "must contain boolean values");
    }
  }
}

function assertPortablePromptBlock(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isPortablePromptRecord(value)) {
    return cognitionValidation("invalid_type", path, "must be a prompt block object");
  }
  const block = value;
  for (const key of Object.keys(block)) {
    if (!Object.hasOwn(PORTABLE_PROMPT_BLOCK_KEYS, key)) cognitionValidation("invalid_type", `${path}.${key}`, "unknown prompt block field");
  }
  for (const key of ["id", "content"] as const) assertPortablePromptText(block[key], `${path}.${key}`);
  // Legacy persisted blocks may omit `name`; validate it whenever present.
  if (Object.hasOwn(block, "name")) assertPortablePromptText(block.name, `${path}.name`);
  if (!["system", "user", "assistant", "user_append", "assistant_append"].includes(String(block.role))) {
    return cognitionValidation("invalid_value", `${path}.role`, "invalid prompt block role");
  }
  if (typeof block.enabled !== "boolean") return cognitionValidation("invalid_type", `${path}.enabled`, "must be a boolean");
  if (!["pre_history", "post_history", "in_history"].includes(String(block.position))) {
    return cognitionValidation("invalid_value", `${path}.position`, "invalid prompt block position");
  }
  if (!Number.isSafeInteger(block.depth) || Number(block.depth) < 0) return cognitionValidation("invalid_value", `${path}.depth`, "must be a non-negative integer");
  if (block.marker !== null && typeof block.marker !== "string") return cognitionValidation("invalid_type", `${path}.marker`, "must be a string or null");
  if (block.color !== null && typeof block.color !== "string") return cognitionValidation("invalid_type", `${path}.color`, "must be a string or null");
  if (block.group !== undefined && block.group !== null && typeof block.group !== "string") {
    return cognitionValidation("invalid_type", `${path}.group`, "must be a string or null");
  }
  if (typeof block.isLocked !== "boolean") return cognitionValidation("invalid_type", `${path}.isLocked`, "must be a boolean");
  assertPortablePromptStringArray(block.injectionTrigger, `${path}.injectionTrigger`);
  if (block.characterTagTrigger !== undefined) assertPortablePromptStringArray(block.characterTagTrigger, `${path}.characterTagTrigger`);
  if (block.categoryMode !== undefined && block.categoryMode !== null && block.categoryMode !== "radio" && block.categoryMode !== "checkbox") {
    return cognitionValidation("invalid_value", `${path}.categoryMode`, "must be radio, checkbox, or null");
  }
  if (block.savedChildEnabled !== undefined) assertPortablePromptVariableState(block.savedChildEnabled, `${path}.savedChildEnabled`);
  if (block.variables !== undefined) {
    if (!Array.isArray(block.variables)) {
      return cognitionValidation("invalid_type", `${path}.variables`, "must be an array");
    }
    if (block.variables.length > COGNITION_MAX_LIST_ITEMS) {
      return cognitionValidation("limit_exceeded", `${path}.variables`, `must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);
    }
    for (const [index, variable] of block.variables.entries()) {
      assertPortablePromptVariable(variable, `${path}.variables[${index}]`);
    }
  }
  if (block.placementBinding !== undefined) {
    assertPortablePromptPlacementBinding(block.placementBinding, `${path}.placementBinding`);
  }
  for (const key of ["stashId", "sealedKey", "sealedSource", "sealedOriginPresetId", "sealedSha256"] as const) {
    if (block[key] !== undefined) assertPortablePromptText(block[key], `${path}.${key}`);
  }
  if (block.sealed !== undefined && typeof block.sealed !== "boolean") return cognitionValidation("invalid_type", `${path}.sealed`, "must be a boolean");
  if (block.sealedOriginVersion !== undefined && block.sealedOriginVersion !== null && typeof block.sealedOriginVersion !== "string") {
    return cognitionValidation("invalid_type", `${path}.sealedOriginVersion`, "must be a string or null");
  }
  if (block.order !== undefined && (!Number.isSafeInteger(block.order) || Number(block.order) < 0)) {
    return cognitionValidation("invalid_value", `${path}.order`, "must be a non-negative integer");
  }
  if (block.revision !== undefined && ((!Number.isSafeInteger(block.revision) || Number(block.revision) < 0) && typeof block.revision !== "string")) {
    return cognitionValidation("invalid_value", `${path}.revision`, "must be a non-negative integer or string");
  }
}
function assertPortablePromptOrder(value: unknown): void {
  if (!Array.isArray(value)) return cognitionValidation("invalid_type", "preset.prompt_order", "must be an array");

  for (const [index, block] of value.entries()) {
    const path = `preset.prompt_order[${index}]`;
    assertPortablePromptBlock(block, path);
    assertPortablePromptNonEmptyText(block.id, `${path}.id`);

    if (block.variables === undefined) continue;
    if (!Array.isArray(block.variables)) {
      return cognitionValidation("invalid_type", `${path}.variables`, "must be an array");
    }
    const variableIds = new Set<string>();
    const variableNames = new Set<string>();
    for (const [variableIndex, variable] of block.variables.entries()) {
      const variablePath = `${path}.variables[${variableIndex}]`;
      assertPortablePromptVariable(variable, variablePath);
      const variableId = variable.id;
      const variableName = variable.name;
      assertPortablePromptNonEmptyText(variableId, `${variablePath}.id`);
      assertPortablePromptNonEmptyText(variableName, `${variablePath}.name`);
      const canonicalVariableId = variableId.trim();
      const canonicalVariableName = variableName.trim();
      if (variableIds.has(canonicalVariableId)) {
        return cognitionValidation("duplicate_id", `${variablePath}.id`, "duplicate variable id");
      }
      if (variableNames.has(canonicalVariableName)) {
        return cognitionValidation("invalid_value", `${variablePath}.name`, "duplicate variable name");
      }
      variableIds.add(canonicalVariableId);
      variableNames.add(canonicalVariableName);
    }
  }
}


function portableJsonBytes(value: unknown, path: string): number {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return cognitionValidation("invalid_type", path, "nested fields must be JSON-serializable"); }
  if (typeof serialized !== "string") return cognitionValidation("invalid_type", path, "nested fields must be JSON-serializable");
  return UTF8_ENCODER.encode(serialized).byteLength;
}
function boundedPortablePresetFields(object: Record<string, unknown>): Record<string, unknown> {
  const bounded = { ...object };
  const presetState: BoundedJsonState = {
    bytes: 0, nodes: 0, active: new WeakSet<object>(), maxBytes: PORTABLE_PRESET_FIELDS_MAX_BYTES,
  };
  for (const key of ["parameters", "prompts", "metadata", "prompt_order"] as const) {
    if (object[key] === undefined) continue;
    bounded[key] = cloneBoundedLegacyJson(object[key], `preset.${key}`, 0, presetState);
  }
  if (bounded.prompt_order !== undefined) assertPortablePromptOrder(bounded.prompt_order);
  const presetFields = Object.fromEntries(
    ["parameters", "prompts", "metadata", "prompt_order"]
      .filter((key) => Object.hasOwn(bounded, key))
      .map((key) => [key, bounded[key]]),
  );
  if (portableJsonBytes(presetFields, "preset") > PORTABLE_PRESET_FIELDS_MAX_BYTES) {
    return cognitionValidation("limit_exceeded", "preset", `nested fields must total at most ${PORTABLE_PRESET_FIELDS_MAX_BYTES} UTF-8 bytes`);
  }
  const regexKey = Object.hasOwn(object, "regex_scripts") ? "regex_scripts" : Object.hasOwn(object, "regexScripts") ? "regexScripts" : undefined;
  if (regexKey) {
    const regexState: BoundedJsonState = {
      bytes: 0, nodes: 0, active: new WeakSet<object>(), maxBytes: PORTABLE_REGEX_FIELDS_MAX_BYTES, maxItems: REGEX_LIMITS_V1.maxScripts,
    };
    bounded[regexKey] = cloneBoundedLegacyJson(object[regexKey], `preset.${regexKey}`, 0, regexState);
    if (portableJsonBytes(bounded[regexKey], `preset.${regexKey}`) > PORTABLE_REGEX_FIELDS_MAX_BYTES) {
      return cognitionValidation("limit_exceeded", `preset.${regexKey}`, `regex scripts must total at most ${PORTABLE_REGEX_FIELDS_MAX_BYTES} UTF-8 bytes`);
    }
  }
  return bounded;
}


export function parsePortablePresetPayload(raw: unknown): PortablePresetPayload {
  const object = parsePortableWireObject(raw);
  const allowed: Record<string, true> = {
    name: true, provider: true, engine: true, parameters: true, prompt_order: true,
    prompts: true, metadata: true, agent_config: true, regex_scripts: true, regexScripts: true,
  };
  for (const key of Object.keys(object)) {
    if (!allowed[key]) throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  const name = object.name;
  if (typeof name !== "string" || !name.trim() || name.length > 512) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  const provider = object.provider;
  if (typeof provider !== "string" || !provider.trim() || provider.length > 256) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  const engine = object.engine;
  if (engine !== undefined && (typeof engine !== "string" || engine.length > 256)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  for (const key of ["parameters", "prompts", "metadata"] as const) {
    const value = object[key];
    const prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
    if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null))) {
      throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
    }
  }
  if (object.prompt_order !== undefined && !Array.isArray(object.prompt_order)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
  }
  if (object.regex_scripts !== undefined && !Array.isArray(object.regex_scripts)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  }
  if (object.regexScripts !== undefined && !Array.isArray(object.regexScripts)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  }
  if (Object.hasOwn(object, "regex_scripts") && Object.hasOwn(object, "regexScripts")) {
    throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  }
  const bounded = boundedPortablePresetFields(object);
  const isRecordArray = (value: unknown): value is readonly Record<string, unknown>[] =>
    Array.isArray(value) && value.every((entry) => isPortablePromptRecord(entry));
  const payload: PortablePresetPayload = { name, provider };
  if (engine !== undefined) payload.engine = engine;
  for (const key of ["parameters", "prompts", "metadata"] as const) {
    if (!Object.hasOwn(object, key)) continue;
    const value = bounded[key];
    if (value === undefined) {
      payload[key] = undefined;
      continue;
    }
    if (!isPortablePromptRecord(value)) throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
    payload[key] = value;
  }
  if (Object.hasOwn(object, "prompt_order")) {
    const value = bounded.prompt_order;
    if (value === undefined) {
      payload.prompt_order = undefined;
    } else if (!Array.isArray(value)) {
      throw new Error("AGENT_RUNTIME_PORTABLE_PRESET_INVALID");
    } else {
      payload.prompt_order = value;
    }
  }
  if (Object.hasOwn(object, "agent_config")) payload.agent_config = bounded.agent_config;
  const regexKey = Object.hasOwn(object, "regex_scripts")
    ? "regex_scripts"
    : Object.hasOwn(object, "regexScripts")
      ? "regexScripts"
      : undefined;
  if (regexKey !== undefined) {
    const value = bounded[regexKey];
    if (!isRecordArray(value)) throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
    payload[regexKey] = value;
  }
  return payload;
}


export function parsePortablePresetRuntimeImportRequest(raw: unknown): PortablePresetRuntimeImportInput {
  const object = parsePortableWireObject(raw);
  assertExactObjectKeys(object, ["preset", "agentRuntime"], "portable preset import");
  return {
    preset: parsePortablePresetPayload(object.preset),
    agentRuntime: parsePortablePresetRuntimeEnvelope(object.agentRuntime),
  };
}

export function decodePortableAgentConfig(raw: unknown): PortableAgentConfigV1 {
  const ingress = parsePortableAgentConfigIngress(parsePortableWireObject(raw));
  return ingress.hasLegacyCognition
    ? { ...ingress.config, cognitionPolicy: ingress.legacyCognition }
    : ingress.config;
}

function foreignConfig(config: AgentConfigV2): AgentConfigV2 {
  return {
    ...config,
    agentsEnabled: false,
    allowedModes: ["response"],
    defaultMode: "response",
    ...(config.runtimePolicy === undefined
      ? {}
      : { runtimePolicy: { ...config.runtimePolicy, defaultMode: "response" } }),
    profiles: config.profiles.map((profile) => ({
      ...profile,
      toolIds: [...profile.toolIds],
      workspaceCapabilities: [...(profile.workspaceCapabilities ?? [])],
    })),
    connectionSlots: config.connectionSlots.map((slot) => ({ ...slot, requiredCapabilities: [...slot.requiredCapabilities] })),
  };
}
export function prepareForeignAgentConfig(config: AgentConfigV2): { config: AgentConfigV2; review: AgentConfigReviewV1 } {
  const inert = foreignConfig(config);
  const unresolvedSlotIds = inert.connectionSlots.map((slot) => slot.id).sort();
  return { config: inert, review: { state: "review_required", reasonCode: "foreign_import", unresolvedSlotIds, staleSlotIds: [], acknowledged: false } };
}

function rowToPreset(row: Record<string, unknown>, projection: PresetAgentConfigProjection): Preset {
  return { id: String(row.id), name: String(row.name), provider: String(row.provider), engine: String(row.engine ?? "classic"), parameters: parseJsonObject(row.parameters), prompt_order: parseJsonArray(row.prompt_order), prompts: parseJsonObject(row.prompts), metadata: scrubMetadata(parseJsonObject(row.metadata)), agent_config: projection.config, agent_config_revision: projection.configRevision, agent_config_review: projection.review, cache_revision: Number(row.cache_revision) || 0, created_at: Number(row.created_at) || 0, updated_at: Number(row.updated_at) || 0 } as Preset;
}

function insertPresetWithDb(db: Database, userId: string, input: PortablePresetPayload, config: AgentConfigV2, review: AgentConfigReviewV1, bindings?: readonly { slotId: string; connectionId: string | null }[], cognitionPolicyOverride?: unknown): { id: string; projection: PresetAgentConfigProjection } {
  const boundedInput = parsePortablePresetPayload(input);
  if (typeof boundedInput.name !== "string" || !boundedInput.name.trim() || typeof boundedInput.provider !== "string" || !boundedInput.provider.trim()) throw new Error("name and provider are required");
  const id = crypto.randomUUID(); const now = Math.floor(Date.now() / 1000);
  db.query("INSERT INTO presets (id, name, provider, engine, parameters, prompt_order, prompts, metadata, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, boundedInput.name.trim(), boundedInput.provider.trim(), boundedInput.engine ?? "classic", JSON.stringify(boundedInput.parameters ?? {}), JSON.stringify(boundedInput.prompt_order ?? []), JSON.stringify(boundedInput.prompts ?? {}), JSON.stringify(scrubMetadata(boundedInput.metadata)), userId, now, now);
  return { id, projection: writeAgentConfigWithDb(db, userId, id, { config, review, bindings, cognitionPolicyOverride }) };
}

function updatePresetWithDb(
  db: Database,
  userId: string,
  presetId: string,
  input: PortablePresetPayload,
  config: AgentConfigV2,
  review: AgentConfigReviewV1,
  expectedPresetRevision: number | undefined,
  bindings: readonly { slotId: string; connectionId: string | null }[] = [],
  cognitionPolicyOverride?: unknown,
): { id: string; projection: PresetAgentConfigProjection } {
  assertPresetOwned(db, userId, presetId);
  const boundedInput = parsePortablePresetPayload(input);
  if (expectedPresetRevision === undefined) throw new Error("PRESET_REVISION_REQUIRED");
  const expected = expectedPresetRevision;
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("PRESET_REVISION_REQUIRED");
  const now = Math.floor(Date.now() / 1000);
  const result = db.query("UPDATE presets SET name = ?, provider = ?, engine = ?, parameters = ?, prompt_order = ?, prompts = ?, metadata = ?, updated_at = ?, cache_revision = cache_revision + 1 WHERE id = ? AND user_id = ? AND cache_revision = ?").run(
    boundedInput.name,
    boundedInput.provider,
    boundedInput.engine ?? "classic",
    JSON.stringify(boundedInput.parameters ?? {}),
    JSON.stringify(boundedInput.prompt_order ?? []),
    JSON.stringify(boundedInput.prompts ?? {}),
    JSON.stringify(scrubMetadata(boundedInput.metadata)),
    now,
    presetId,
    userId,
    expected,
  );
  if (result.changes !== 1) throw new Error("PRESET_REVISION_CONFLICT");
  const currentProjection = readNormalizedProjection(db, userId, presetId);
  const expectedConfigRevision = currentProjection?.configRevision ?? 0;
  const projection = writeAgentConfigWithDb(db, userId, presetId, {
    config,
    review,
    bindings,
    expectedConfigRevision,
    cognitionPolicyOverride,
  });
  return { id: presetId, projection };
}

function readPortableRegexScripts(input: PortablePresetPayload): readonly Record<string, unknown>[] {
  const hasSnakeCase = Object.hasOwn(input, "regex_scripts");
  const hasCamelCase = Object.hasOwn(input, "regexScripts");
  if (hasSnakeCase && hasCamelCase) throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  const value = hasSnakeCase ? input.regex_scripts : input.regexScripts;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");
  return value;
}

const PORTABLE_PRESET_REGEX_SOURCE_FINGERPRINT = "lumiverse_portable_source_fingerprint";
const PORTABLE_PRESET_REGEX_CURRENT_FINGERPRINT = "lumiverse_portable_current_fingerprint";

function fingerprintPortableRegexScripts(scripts: readonly Record<string, unknown>[]): string {
  return createHash("sha256").update(canonicalJsonValue(scripts)).digest("hex");
}

function regexFingerprintMetadata(script: Record<string, unknown>, key: string): unknown {
  const metadata = script.metadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)[key]
    : undefined;
}

function currentPortableRegexFingerprint(scripts: readonly Record<string, unknown>[]): string {
  const semanticScripts = scripts.map((script) => {
    const metadata = typeof script.metadata === "object" && script.metadata !== null && !Array.isArray(script.metadata)
      ? { ...(script.metadata as Record<string, unknown>) }
      : {};
    delete metadata[PORTABLE_PRESET_REGEX_SOURCE_FINGERPRINT];
    delete metadata[PORTABLE_PRESET_REGEX_CURRENT_FINGERPRINT];
    // Execution evidence is operational telemetry, not authored regex semantics.
    delete metadata.regex_performance;
    delete metadata.regex_evidence;
    return { ...script, metadata };
  });
  return fingerprintPortableRegexScripts(semanticScripts);
}

export function portablePresetRegexScriptsMatchStored(
  userId: string,
  presetId: string,
  scripts: readonly Record<string, unknown>[],
): boolean {
  const existing = regexScriptsService.exportRegexScripts(userId, { presetId }).scripts as readonly Record<string, unknown>[];
  if (sameJsonValue(scripts, existing)) return true;
  if (scripts.length !== existing.length || scripts.length === 0) return false;
  const sourceFingerprint = fingerprintPortableRegexScripts(scripts);
  const expectedCurrentFingerprint = currentPortableRegexFingerprint(existing);
  return existing.every((script) => (
    regexFingerprintMetadata(script, PORTABLE_PRESET_REGEX_SOURCE_FINGERPRINT) === sourceFingerprint
    && regexFingerprintMetadata(script, PORTABLE_PRESET_REGEX_CURRENT_FINGERPRINT) === expectedCurrentFingerprint
  ));
}
function remapPortableRegexReferences(value: unknown, ids: ReadonlyMap<string, string>, key?: string): unknown {
  if (typeof value === "string" && key && /^(?:script_id|scriptId|regex_script_id|regexScriptId|imported_script_id)$/.test(key)) {
    return ids.get(value) ?? ids.get(value.toLowerCase()) ?? value;
  }
  if (Array.isArray(value)) return value.map((entry) => remapPortableRegexReferences(entry, ids));
  if (typeof value !== "object" || value === null) return value;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
    output[entryKey] = remapPortableRegexReferences(entry, ids, entryKey);
  }
  return output;
}

function preparePortableRegexScripts(
  scripts: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const sourceFingerprint = fingerprintPortableRegexScripts(scripts);
  const ids = new Map<string, string>();
  for (const [index, script] of scripts.entries()) {
    if (typeof script !== "object" || script === null || Array.isArray(script)) {
      throw new Error(`AGENT_RUNTIME_PORTABLE_REGEX_INVALID:${index}`);
    }
    const sourceId = typeof script.script_id === "string" ? script.script_id.trim() : "";
    if (!sourceId) continue;
    if (ids.has(sourceId) || ids.has(sourceId.toLowerCase())) {
      throw new Error(`AGENT_RUNTIME_PORTABLE_REGEX_INVALID:${index}:duplicate_script_id`);
    }
    const localId = `portable_${crypto.randomUUID().replaceAll("-", "")}`;
    ids.set(sourceId, localId);
    ids.set(sourceId.toLowerCase(), localId);
  }
  return scripts.map((source) => {
    const sourceId = typeof source.script_id === "string" ? source.script_id.trim() : "";
    const localId = sourceId ? ids.get(sourceId) : undefined;
    const withoutOwnership = { ...source };
    delete withoutOwnership.id;
    delete withoutOwnership.user_id;
    delete withoutOwnership.pack_id;
    delete withoutOwnership.preset_id;
    delete withoutOwnership.character_id;
    delete withoutOwnership.owner_extension_identifier;
    delete withoutOwnership.validation_error_code;
    delete withoutOwnership.created_at;
    delete withoutOwnership.updated_at;
    withoutOwnership.script_id = localId ?? `portable_${crypto.randomUUID().replaceAll("-", "")}`;
    withoutOwnership.scope = "global";
    withoutOwnership.scope_id = null;
    const sourceMetadata = typeof withoutOwnership.metadata === "object" && withoutOwnership.metadata !== null && !Array.isArray(withoutOwnership.metadata)
      ? withoutOwnership.metadata as Record<string, unknown>
      : {};
    withoutOwnership.metadata = {
      ...sourceMetadata,
      [PORTABLE_PRESET_REGEX_SOURCE_FINGERPRINT]: sourceFingerprint,
    };
    return remapPortableRegexReferences(withoutOwnership, ids) as Record<string, unknown>;
  });
}


/**
 * Import preset-bound regex companions while the caller's database transaction
 * is open. The lower-level importer retains invalid foreign scripts as
 * disabled/quarantined rows, but malformed entries and persistence conflicts
 * are integrity failures for a portable preset and must abort the transaction.
 */
export function importPortablePresetRegexScriptsWithDb(
  db: Database,
  userId: string,
  presetId: string,
  presetName: string,
  input: PortablePresetPayload,
): { imported: number; skipped: number } {
  const scripts = preparePortableRegexScripts(readPortableRegexScripts(input));
  if (scripts.length === 0) return { imported: 0, skipped: 0 };
  const result = regexScriptsService.importPresetBoundRegexScripts(
    userId,
    presetId,
    presetName,
    [...scripts],
    undefined,
    { suppressPresetAuthorityMutation: true },
  );
  if (result.skipped !== 0 || result.imported !== scripts.length) {
    throw new Error(`AGENT_RUNTIME_PORTABLE_REGEX_INVALID:skipped=${result.skipped}`);
  }
  const stored = regexScriptsService.exportRegexScripts(userId, { presetId }).scripts as readonly Record<string, unknown>[];
  const currentFingerprint = currentPortableRegexFingerprint(stored);
  const rows = db.query(
    "SELECT id, metadata FROM regex_scripts WHERE user_id = ? AND preset_id = ?",
  ).all(userId, presetId) as Array<{ id: string; metadata?: string }>;
  const updateMetadata = db.query(
    "UPDATE regex_scripts SET metadata = ? WHERE id = ? AND user_id = ? AND preset_id = ?",
  );
  for (const row of rows) {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata ?? "{}");
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) metadata = parsed;
    } catch {}
    updateMetadata.run(
      JSON.stringify({ ...metadata, [PORTABLE_PRESET_REGEX_CURRENT_FINGERPRINT]: currentFingerprint }),
      row.id,
      userId,
      presetId,
    );
  }
  return result;
}

function withCommittedPortableImportEvents<T>(callback: () => T): T {
  const buffered = eventBus.withBufferedEvents(callback);
  for (const event of buffered.events) {
    eventBus.emit(event.event, event.payload, event.userId, event.options);
  }
  return buffered.value;
}
export function importPortablePreset(userId: string, input: PortablePresetPayload): PortablePresetImportResult {
  const db = getDb();
  const preset = parsePortablePresetPayload(input);
  const rawConfig = preset.agent_config;
  const ingress = rawConfig === undefined ? null : parsePortableAgentConfigIngress(rawConfig);
  const portable = ingress?.config ?? null;
  const hasLegacyCognition = ingress?.hasLegacyCognition === true;
  const legacyCognition = ingress?.legacyCognition;
  const authored = portable
    ? (() => {
      const { portableVersion: _portableVersion, ...authoredPortable } = portable;
      return parseAgentConfigV2({ ...authoredPortable, version: 2 });
    })()
    : createDisabledAgentConfigV2();
  const preparedBase = prepareForeignAgentConfig(authored);
  const cognition = hasLegacyCognition
    ? { state: "repair_required" as const, reasonCode: "cognition_invalid" }
    : cognitionReview(userId, "portable-import", authored, "foreign", true);
  const prepared = {
    config: preparedBase.config,
    review: {
      ...preparedBase.review,
      state: hasLegacyCognition ? "repair_required" as const : preparedBase.review.state,
      reasonCode: cognition.reasonCode ?? preparedBase.review.reasonCode,
    },
  };
  return withCommittedPortableImportEvents(() => db.transaction(() => {
    const stored = insertPresetWithDb(db, userId, preset, prepared.config, prepared.review, undefined, hasLegacyCognition ? legacyCognition : undefined);
    importPortablePresetRegexScriptsWithDb(db, userId, stored.id, preset.name, preset);
    const row = assertPresetOwned(db, userId, stored.id);
    return { preset: rowToPreset(row, stored.projection), agent_config: stored.projection.config, agent_config_review: stored.projection.review };
  })());
}

export interface PortablePresetRuntimeImportInput {
  preset: PortablePresetPayload;
  agentRuntime: unknown;
  /** Existing LumiHub installation to replace transactionally, when present. */
  existingPresetId?: string;
  expectedPresetRevision?: number;
}

export function importPortablePresetRuntime(userId: string, input: PortablePresetRuntimeImportInput): PortablePresetImportResult {
  const db = getDb();
  const preset = parsePortablePresetPayload(input.preset);
  const envelope = parsePortablePresetRuntimeEnvelope(input.agentRuntime);
  return withCommittedPortableImportEvents(() => db.transaction(() => {
    const configIngress = envelope.agentConfig ? parsePortableAgentConfigIngress(envelope.agentConfig) : null;
    const portable = configIngress?.config ?? toPortableAgentConfigV1(createDisabledAgentConfigV2());
    const hasLegacyCognition = configIngress?.hasLegacyCognition === true;
    const legacyCognition = configIngress?.legacyCognition;
    const { portableVersion: _portableVersion, ...authoredPortable } = portable;
    const importedConfig = parseAgentConfigV2({
      ...authoredPortable,
      version: 2,
      agentsEnabled: false,
      allowedModes: ["response"],
      defaultMode: "response",
    });
    const graph = parsePortableTaskGraph(envelope.taskTemplates, importedConfig);
    const preparedForeign = prepareForeignAgentConfig(importedConfig);
    const importedReview = hasLegacyCognition
      ? { ...preparedForeign.review, state: "repair_required" as const, reasonCode: "cognition_invalid" }
      : { ...preparedForeign.review, reasonCode: "foreign_import" };
    const targetConfig = preparedForeign.config;
    const stored = input.existingPresetId
      ? updatePresetWithDb(db, userId, input.existingPresetId, preset, targetConfig, importedReview, input.expectedPresetRevision, [], hasLegacyCognition ? legacyCognition : undefined)
      : insertPresetWithDb(db, userId, preset, targetConfig, importedReview, undefined, hasLegacyCognition ? legacyCognition : undefined);
    const authoredRow = {
      config: targetConfig,
      taskTemplates: graph.taskTemplates,
      reviewAcknowledgements: [],
    };
    db.query("UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?")
      .run(JSON.stringify(authoredRow), userId, stored.id);
    if (input.existingPresetId) {
      regexScriptsService.deleteRegexScriptsByPresetId(userId, stored.id);
    }
    importPortablePresetRegexScriptsWithDb(db, userId, stored.id, preset.name, preset);
    const row = assertPresetOwned(db, userId, stored.id);
    return { preset: rowToPreset(row, stored.projection), agent_config: stored.projection.config, agent_config_review: stored.projection.review };
  })());
}

function copyRegexCompanionsWithDb(db: Database, userId: string, sourcePresetId: string, targetPresetId: string): string[] {
  if (!tableExists(db, "regex_scripts")) return [];
  const rows = db.query("SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY sort_order ASC, created_at ASC").all(userId, sourcePresetId) as Array<Record<string, unknown>>;
  const columns = (db.query("PRAGMA table_info(regex_scripts)").all() as Array<{ name: string }>).map((column) => column.name); const copyable = columns.filter((column) => column !== "id" && column !== "user_id" && column !== "preset_id"); const copied: string[] = [];
  for (const row of rows) { const id = crypto.randomUUID(); const allColumns = ["id", "user_id", "preset_id", ...copyable]; const values = [id, userId, targetPresetId, ...copyable.map((column) => column === "script_id" ? `${String(row[column] ?? "script")}-${id.slice(0, 8)}`.slice(0, 255) : row[column] ?? null)]; const quoted = allColumns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", "); db.query(`INSERT INTO regex_scripts (${quoted}) VALUES (${allColumns.map(() => "?").join(", ")})`).run(...(values as any[])); copied.push(id); }
  return copied;
}
function readValidatedAuthoredRuntimeEnvelopeJson(
  db: Database,
  userId: string,
  presetId: string,
  projection: PresetAgentConfigProjection,
): string {
  const row = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_json?: unknown } | null
    : null;
  const raw = row?.config_json;
  if (typeof raw !== "string" || raw.trim() === "") return "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_RUNTIME_AUTHORED_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AGENT_RUNTIME_AUTHORED_INVALID");
  }
  const envelope = parsed as Record<string, unknown>;
  if (Object.keys(envelope).length === 0) return raw;

  try {
    assertExactObjectKeys(
      envelope,
      ["config"],
      "authored agent runtime",
      ["taskTemplates", "reviewAcknowledgements"],
    );
    const config = parseAgentConfigV2(envelope.config);
    const taskTemplates = normalizeDraftList(envelope.taskTemplates, "taskTemplates")
      .map((template) => parseTaskTemplate(template));
    parsePortableTaskGraph(taskTemplates, config);
    normalizeReviewAcknowledgements(
      envelope.reviewAcknowledgements ?? [],
      reviewItemIds(projection.review),
    );
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`AGENT_RUNTIME_AUTHORED_INVALID${detail}`);
  }

  // Preserve the validated bytes exactly. In particular, labels and authored
  // review acknowledgements are part of the editor envelope and must not be
  // reconstructed from the normalized projection during duplication.
  return raw;
}

export function duplicatePresetWithAgentConfig(userId: string, sourcePresetId: string, name?: string): PresetDuplicateResult {
  const db = getDb();
  return db.transaction(() => {
    const source = assertPresetOwned(db, userId, sourcePresetId);
    const sourceProjection = getPresetAgentConfig(userId, sourcePresetId);
    if (!sourceProjection) throw new Error("Preset agent config not found");
    const persistedLegacy = readPersistedLegacyCognitionPolicy(db, userId, sourcePresetId, sourceProjection);
    const authoredRuntimeEnvelope = readValidatedAuthoredRuntimeEnvelopeJson(
      db,
      userId,
      sourcePresetId,
      sourceProjection,
    );
    const targetConfig = sourceProjection.config;
    const inserted = insertPresetWithDb(
      db,
      userId,
      {
        name: name?.trim() || `${String(source.name)} copy`,
        provider: String(source.provider),
        engine: String(source.engine ?? "classic"),
        parameters: parseJsonObject(source.parameters),
        prompt_order: parseJsonArray(source.prompt_order),
        prompts: parseJsonObject(source.prompts),
        metadata: scrubMetadata(parseJsonObject(source.metadata)),
      },
      targetConfig,
      sourceProjection.review,
      [],
      persistedLegacy?.value,
    );
    const targetPreset = assertPresetOwned(db, userId, inserted.id);
    const targetPresetRevision = Number(targetPreset.cache_revision) || 0;
    let targetAuthoredRuntimeEnvelope = authoredRuntimeEnvelope;
    if (authoredRuntimeEnvelope !== "{}") {
      const parsedEnvelope = parseJsonObject(authoredRuntimeEnvelope);
      targetAuthoredRuntimeEnvelope = JSON.stringify({
        ...parsedEnvelope,
        // Keep exact Loom source bindings across duplication. A new preset
        // revision must surface stale references for explicit repair.
        config: targetConfig,
      });
    }
    db.query("UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?")
      .run(targetAuthoredRuntimeEnvelope, userId, inserted.id);

    const nextTargetPresetRevision = Math.max(targetPresetRevision, Number(source.cache_revision) || 0) + 1;
    const authorityAdvance = db.query(
      "UPDATE presets SET cache_revision = ?, updated_at = ? WHERE id = ? AND user_id = ? AND cache_revision = ?",
    ).run(nextTargetPresetRevision, Math.floor(Date.now() / 1000), inserted.id, userId, targetPresetRevision);
    if (authorityAdvance.changes !== 1) throw new Error("PRESET_REVISION_CONFLICT");
    quarantineAgentConfigForPresetRevisionWithDb(
      db,
      userId,
      inserted.id,
      nextTargetPresetRevision,
      parseJsonArray(targetPreset.prompt_order),
    );
    const copiedRegexScriptIds = copyRegexCompanionsWithDb(db, userId, sourcePresetId, inserted.id);
    const row = assertPresetOwned(db, userId, inserted.id);
    const projection = getPresetAgentConfig(userId, inserted.id)!;
    return { preset: rowToPreset(row, projection), agent_config: projection.config, agent_config_review: projection.review, copiedRegexScriptIds };
  })();
}

export function getChatAgentModeOverride(userId: string, chatId: string): ChatAgentModeOverride | null {
  const db = getDb();
  if (!tableExists(db, "chat_agent_mode_overrides")) return null;
  const row = db.query("SELECT mode, revision, state, review_code, review_acknowledged FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?").get(userId, chatId) as { mode: "response" | "agentic" | null; revision: number; state: AgentConfigStateV1; review_code: string | null; review_acknowledged: number } | null;
  return row ? { mode: row.mode ?? null, revision: Number(row.revision) || 1, state: row.state, reviewCode: row.review_code ?? null, acknowledged: Number(row.review_acknowledged) === 1 } : null;
}

export function setChatAgentModeOverride(userId: string, chatId: string, mode: "response" | "agentic" | null, expectedRevision?: number): ChatAgentModeOverride | null {
  const db = getDb();
  if (!tableExists(db, "chat_agent_mode_overrides")) return null;
  if (expectedRevision === undefined) throw new Error("AGENT_CHAT_MODE_REVISION_REQUIRED");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("AGENT_CHAT_MODE_REVISION_REQUIRED");
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("AGENT_CHAT_MODE_REVISION_CONFLICT");
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM chats WHERE user_id = ? AND id = ?").get(userId, chatId)) return null;
    const now = Math.floor(Date.now() / 1000);
    const result = expectedRevision === 0
      ? db.query("INSERT INTO chat_agent_mode_overrides (user_id, chat_id, mode, revision, state, review_code, review_acknowledged, updated_at) VALUES (?, ?, ?, 1, 'ready', NULL, 1, ?) ON CONFLICT(user_id, chat_id) DO NOTHING").run(userId, chatId, mode, now)
      : db.query("UPDATE chat_agent_mode_overrides SET mode = ?, revision = ?, state = 'ready', review_code = NULL, review_acknowledged = 1, updated_at = ? WHERE user_id = ? AND chat_id = ? AND revision = ?").run(mode, expectedRevision + 1, now, userId, chatId, expectedRevision);
    if (result.changes !== 1) throw new Error("AGENT_CHAT_MODE_REVISION_CONFLICT");
    return getChatAgentModeOverride(userId, chatId);
  })();
}

export const scrubPresetMetadata = scrubMetadata;

export interface AgentRuntimeSharedDraftV1 {
  config: unknown;
  slotBindings?: readonly { slotId?: unknown; connectionId?: unknown }[];
  taskTemplates?: readonly unknown[];
  reviewAcknowledgements?: unknown;
  promptOrder?: unknown[];
  expectedPresetRevision?: number;
  expectedConfigRevision?: number;
}

export interface AgentRuntimeSharedDraftResultV1 {
  preset: Preset;
  editor: {
    presetId: string;
    presetRevision: number;
    configRevision: number;
    config: AgentConfigV2;
    review: AgentRuntimeEditorReviewV1;
    slotBindings: PresetAgentSlotBindingV1[];
    taskTemplates: unknown[];
    reviewAcknowledgements: string[];
    hostCeilings: AgentRuntimeHostLimits;
  };
}

function normalizeDraftList(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.slice();
}

export interface AgentPresetCognitionSourceV1 {
  presetId: string;
  presetRevision: number;
  configRevision: number;
  config: AgentConfigV2;
  taskTemplates: readonly unknown[];
  review: AgentConfigReviewV1;
}

function normalizeDraftConfig(raw: unknown, taskTemplates: readonly unknown[]): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("AGENT_CONFIG_INVALID");
  const input = { ...(raw as Record<string, unknown>) };
  if (taskTemplates.length > 0 && !Object.hasOwn(input, "taskPolicy")) {
    const parsed = taskTemplates.map((template) => parseTaskTemplate(template));
    input.taskPolicy = { templateIds: parsed.map((template) => template.id) };
  }
  return input;
}

function parseAuthoredCognitionEnvelope(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "{}") return null;
  }
  if (typeof raw !== "string" || UTF8_ENCODER.encode(raw).byteLength > PORTABLE_PRESET_FIELDS_MAX_BYTES) {
    throw new Error("AGENT_RUNTIME_PORTABLE_COGNITION_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_RUNTIME_PORTABLE_COGNITION_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AGENT_RUNTIME_PORTABLE_COGNITION_INVALID");
  }
  try {
    const authored = parsed as Record<string, unknown>;
    assertExactObjectKeys(authored, ["config"], "authored agent runtime", ["taskTemplates", "reviewAcknowledgements"]);
    return authored;
  } catch {
    throw new Error("AGENT_RUNTIME_PORTABLE_COGNITION_INVALID");
  }
}
function readAuthoredCognitionSource(
  db: Database,
  userId: string,
  presetId: string,
  projection: PresetAgentConfigProjection,
  options: { readonly allowQuarantined?: boolean } = {},
): AgentPresetCognitionSourceV1 | null {
  if (!options.allowQuarantined && projection.review.state !== "ready") return null;
  const preset = db.query("SELECT cache_revision FROM presets WHERE user_id = ? AND id = ?").get(userId, presetId) as { cache_revision?: unknown } | null;
  const row = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_json?: unknown } | null
    : null;
  if (!preset || !row) return null;
  const authored = parseAuthoredCognitionEnvelope(row.config_json);
  if (!authored) return null;
  const authoredConfig = authored.config;
  const hasCanonicalRuntimePolicy = authoredConfig !== null
    && typeof authoredConfig === "object"
    && !Array.isArray(authoredConfig)
    && Object.hasOwn(authoredConfig, "runtimePolicy");
  if (
    !Object.hasOwn(authored, "taskTemplates")
    && projection.config.taskPolicy === undefined
    && !hasCanonicalRuntimePolicy
  ) return null;
  try {
    const taskTemplates = normalizeDraftList(authored.taskTemplates, "taskTemplates")
      .map((template) => parseTaskTemplate(template));
    const authoredConfig = normalizeDraftConfig(authored.config, taskTemplates);
    const config = parseAgentConfigV2({
      ...projection.config,
      ...(authoredConfig as Record<string, unknown>),
    });
    parsePortableTaskGraph(taskTemplates, config);
    return {
      presetId,
      presetRevision: Number(preset.cache_revision) || 0,
      configRevision: projection.configRevision,
      config,
      taskTemplates,
      review: projection.review,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_RUNTIME_PORTABLE_COGNITION_INVALID") throw error;
    throw new Error("AGENT_RUNTIME_PORTABLE_COGNITION_INVALID");
  }
}

export function getPresetAgentCognitionSourceV1(userId: string, presetId: string): AgentPresetCognitionSourceV1 | null {
  const db = getDb();
  const projection = getPresetAgentConfig(userId, presetId);
  if (!projection) return null;
  return readAuthoredCognitionSource(db, userId, presetId, projection);
}

export interface AgentPresetResponseCognitionSourceV1 extends AgentPresetCognitionSourceV1 {
  /** Explicit source tier used for owner-visible Response omission evidence. */
  readonly sourceKind: "normalized" | "authored" | "legacy";
  readonly reviewReason: string | null;
  readonly conservativeExcludedBlockIds: readonly string[];
}

function resolveLegacyLoomSourceOrder(
  promptOrder: readonly unknown[],
  blockId: string,
  blockRevision: number,
  explicitOrder: unknown,
): number | null {
  const exactOccurrence = (order: number): boolean => {
    const value = promptOrder[order];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return row.id === blockId
      && row.marker !== "category"
      && promptBlockRevision(value) === blockRevision;
  };
  if (explicitOrder !== undefined) {
    if (!Number.isSafeInteger(explicitOrder) || (explicitOrder as number) < 0) return null;
    return exactOccurrence(explicitOrder as number) ? explicitOrder as number : null;
  }
  let matchedOrder: number | null = null;
  for (let order = 0; order < promptOrder.length; order += 1) {
    const value = promptOrder[order];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    if ((value as Record<string, unknown>).id !== blockId) continue;
    if (matchedOrder !== null) return null;
    matchedOrder = order;
  }
  return matchedOrder !== null && exactOccurrence(matchedOrder) ? matchedOrder : null;
}
function responseLegacyPolicyEntry(
  bucket: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy",
  ref: unknown,
  index: number,
  promptOrder: readonly unknown[],
  presetRevision: number,
): Record<string, unknown> | null {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  const raw = ref as Record<string, unknown>;
  const blockId = typeof raw.blockId === "string" && raw.blockId.length > 0 ? raw.blockId : null;
  const expectedPresetRevision = Number(raw.expectedPresetRevision);
  const expectedBlockRevision = Number(raw.expectedBlockRevision);
  if (!blockId || !Number.isSafeInteger(expectedPresetRevision) || expectedPresetRevision !== presetRevision
    || !Number.isSafeInteger(expectedBlockRevision) || expectedBlockRevision < 0) return null;
  const sourceOrder = resolveLegacyLoomSourceOrder(promptOrder, blockId, expectedBlockRevision, raw.promptOrder);
  if (sourceOrder === null) return null;
  const destination = bucket === "completionCriteria" ? "completion_handoff" : bucket === "renderPolicy" ? "render" : "root_work";
  const checkpoint = bucket === "completionCriteria" ? "PREPARE_COMMIT" : bucket === "renderPolicy" ? "RENDER" : "WORK";
  return {
    version: 1,
    id: "legacy:" + bucket + ":" + index + ":" + blockId,
    source: { kind: "loom_block", blockId, presetRevision: expectedPresetRevision, blockRevision: expectedBlockRevision, promptOrder: sourceOrder },
    destination, checkpoint, required: true, visibility: "work_only",
  };
}

function responseLegacyPhaseSource(
  ref: unknown,
  promptOrder: readonly unknown[],
  presetRevision: number,
): Record<string, unknown> | null {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  const raw = ref as Record<string, unknown>;
  const source = raw.source && typeof raw.source === "object" && !Array.isArray(raw.source)
    ? raw.source as Record<string, unknown>
    : raw;
  const blockId = typeof source.blockId === "string" && source.blockId.length > 0 ? source.blockId : null;
  const expectedPresetRevision = Number(source.presetRevision ?? source.expectedPresetRevision);
  const expectedBlockRevision = Number(source.blockRevision ?? source.expectedBlockRevision);
  if (!blockId || !Number.isSafeInteger(expectedPresetRevision) || expectedPresetRevision !== presetRevision
    || !Number.isSafeInteger(expectedBlockRevision) || expectedBlockRevision < 0) return null;
  const order = resolveLegacyLoomSourceOrder(promptOrder, blockId, expectedBlockRevision, source.promptOrder);
  if (order === null) return null;
  return {
    kind: "loom_block",
    blockId,
    presetRevision: expectedPresetRevision,
    blockRevision: expectedBlockRevision,
    promptOrder: order,
  };
}

function legacyResponsePhase(
  phase: unknown,
  index: number,
  promptOrder: readonly unknown[],
  presetRevision: number,
): Record<string, unknown> | null {
  if (typeof phase !== "object" || phase === null || Array.isArray(phase)) return null;
  const raw = phase as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : "legacy-phase-" + index;
  const instructionRefs = Array.isArray(raw.instructionRefs)
    ? raw.instructionRefs.flatMap((ref) => {
      const source = responseLegacyPhaseSource(ref, promptOrder, presetRevision);
      return source ? [source] : [];
    })
    : [];
  const childInstructionSubsets = Array.isArray(raw.childInstructionSubsets)
    ? raw.childInstructionSubsets.flatMap((subset) => {
      if (typeof subset !== "object" || subset === null || Array.isArray(subset)) return [];
      const value = subset as Record<string, unknown>;
      const profileId = typeof value.profileId === "string" && value.profileId.length > 0 ? value.profileId : null;
      const refs = Array.isArray(value.instructionRefs)
        ? value.instructionRefs.flatMap((ref) => {
          const source = responseLegacyPhaseSource(ref, promptOrder, presetRevision);
          return source ? [source] : [];
        })
        : [];
      return profileId && refs.length > 0 ? [{ profileId, instructionRefs: refs }] : [];
    })
    : [];
  if (instructionRefs.length === 0 && childInstructionSubsets.length === 0) return null;
  return { version: 1, id, label: typeof raw.label === "string" ? raw.label : id, instructionRefs, childInstructionSubsets };
}

function legacyResponsePhases(
  phasePolicy: Record<string, unknown>,
  cognitionPolicy: Record<string, unknown>,
  promptOrder: readonly unknown[],
  presetRevision: number,
): readonly Record<string, unknown>[] {
  const value = Array.isArray(phasePolicy.phases) ? phasePolicy.phases : Array.isArray(cognitionPolicy.phases) ? cognitionPolicy.phases : [];
  return value.flatMap((phase, index) => {
    const parsed = legacyResponsePhase(phase, index, promptOrder, presetRevision);
    return parsed ? [parsed] : [];
  });
}
function legacyResponseRuntimePolicy(
  carrierRow: Record<string, unknown>,
  promptOrder: readonly unknown[],
  presetRevision: number,
): unknown | null {
  const phasePolicy = parseJsonObject(carrierRow.phase_policy_json);
  const cognitionPolicy = parseJsonObject(carrierRow.cognition_policy_json);
  const bucketValues: Record<string, unknown> = {
    workPolicy: Array.isArray(phasePolicy.work) ? phasePolicy.work : Array.isArray(cognitionPolicy.workPolicy) ? cognitionPolicy.workPolicy : [],
    workspaceUsage: Array.isArray(cognitionPolicy.workspaceUsage) ? cognitionPolicy.workspaceUsage : [],
    completionCriteria: Array.isArray(cognitionPolicy.completionCriteria) ? cognitionPolicy.completionCriteria : [],
    renderPolicy: Array.isArray(phasePolicy.render) ? phasePolicy.render : Array.isArray(cognitionPolicy.renderPolicy) ? cognitionPolicy.renderPolicy : [],
  };
  const policy = {} as Record<string, unknown>;
  for (const bucket of ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"] as const) {
    const entries = Array.isArray(bucketValues[bucket]) ? bucketValues[bucket] : [];
    policy[bucket] = entries.flatMap((entry, index) => {
      const parsed = responseLegacyPolicyEntry(bucket, entry, index, promptOrder, presetRevision);
      return parsed ? [parsed] : [];
    });
  }
  const phases = legacyResponsePhases(phasePolicy, cognitionPolicy, promptOrder, presetRevision);
  if (Object.values(policy).every((entries) => Array.isArray(entries) && entries.length === 0) && phases.length === 0) return null;
  return { version: 1, authority: "loom", scope: "preset", defaultMode: "response", loomPolicy: { version: 1, ...policy }, phases };
}
function boundedResponseCarrierObject(value: unknown, maxBytes: number): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (UTF8_ENCODER.encode(value).byteLength > maxBytes) return {};
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  try {
    const bounded = cloneBoundedLegacyJson(parsed, "responseCarrier", 0, {
      bytes: 0,
      nodes: 0,
      active: new WeakSet<object>(),
      maxBytes,
    });
    if (typeof bounded !== "object" || bounded === null || Array.isArray(bounded)) return {};
    return bounded as Record<string, unknown>;
  } catch {
    return {};
  }
}
function responseCarrierBlockIds(carrierRow: Record<string, unknown>): readonly string[] {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    if (UTF8_ENCODER.encode(value).byteLength > COGNITION_MAX_ID_BYTES) return;
    if (ids.size >= COGNITION_MAX_BLOCK_REFS_TOTAL) return;
    ids.add(value);
  };
  const phasePolicy = boundedResponseCarrierObject(carrierRow.phase_policy_json, COGNITION_MAX_LIST_BYTES);
  const cognitionPolicy = boundedResponseCarrierObject(carrierRow.cognition_policy_json, COGNITION_MAX_LIST_BYTES);
  const configEnvelope = boundedResponseCarrierObject(carrierRow.config_json, PORTABLE_PRESET_FIELDS_MAX_BYTES);
  for (const bucket of ["work", "render"]) {
    const refs = phasePolicy[bucket];
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
      add((ref as Record<string, unknown>).blockId);
    }
  }
  for (const bucket of ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"]) {
    const refs = cognitionPolicy[bucket];
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
      add((ref as Record<string, unknown>).blockId);
    }
  }
  for (const phases of [phasePolicy.phases, cognitionPolicy.phases]) {
    if (!Array.isArray(phases)) continue;
    for (const phase of phases) {
      if (typeof phase !== "object" || phase === null || Array.isArray(phase)) continue;
      const raw = phase as Record<string, unknown>;
      const instructionGroups: unknown[] = [raw.instructionRefs];
      if (Array.isArray(raw.childInstructionSubsets)) {
        for (const subset of raw.childInstructionSubsets) {
          if (typeof subset !== "object" || subset === null || Array.isArray(subset)) continue;
          instructionGroups.push((subset as Record<string, unknown>).instructionRefs);
        }
      }
      for (const refs of instructionGroups) {
        if (!Array.isArray(refs)) continue;
        for (const ref of refs) {
          if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
          const rec = ref as Record<string, unknown>;
          const source = rec.source;
          const nested = source && typeof source === "object" && !Array.isArray(source)
            ? (source as Record<string, unknown>).blockId
            : undefined;
          add(nested ?? rec.blockId);
        }
      }
    }
  }
  const config = configEnvelope.config;
  const runtimePolicy = config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>).runtimePolicy
    : undefined;
  const runtimePolicyRow = runtimePolicy && typeof runtimePolicy === "object" && !Array.isArray(runtimePolicy)
    ? runtimePolicy as Record<string, unknown>
    : null;
  if (runtimePolicyRow) {
    const loomPolicy = runtimePolicyRow.loomPolicy;
    const loomPolicyRow = loomPolicy && typeof loomPolicy === "object" && !Array.isArray(loomPolicy)
      ? loomPolicy as Record<string, unknown>
      : null;
    if (loomPolicyRow) {
      for (const bucket of ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"]) {
        const entries = loomPolicyRow[bucket];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
          const source = (entry as Record<string, unknown>).source;
          if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
          add((source as Record<string, unknown>).blockId);
        }
      }
    }
    if (Array.isArray(runtimePolicyRow.phases)) {
      for (const phase of runtimePolicyRow.phases) {
        if (typeof phase !== "object" || phase === null || Array.isArray(phase)) continue;
        const raw = phase as Record<string, unknown>;
        const instructionGroups: unknown[] = [raw.instructionRefs];
        if (Array.isArray(raw.childInstructionSubsets)) {
          for (const subset of raw.childInstructionSubsets) {
            if (typeof subset !== "object" || subset === null || Array.isArray(subset)) continue;
            instructionGroups.push((subset as Record<string, unknown>).instructionRefs);
          }
        }
        for (const refs of instructionGroups) {
          if (!Array.isArray(refs)) continue;
          for (const ref of refs) {
            if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
            const source = (ref as Record<string, unknown>).source;
            if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
            add((source as Record<string, unknown>).blockId);
          }
        }
      }
    }
  }
  return [...ids];
}


/**
 * Owner-visible Response inspection source. This intentionally never feeds the
 * runtime admission path: it recovers exact Loom provenance even while the
 * authored config is quarantined, but only exposes closed policy references.
 */
export function getPresetAgentResponseCognitionSourceV1(userId: string, presetId: string): AgentPresetResponseCognitionSourceV1 | null {
  const db = getDb();
  const projection = getPresetAgentConfig(userId, presetId);
  if (!projection) return null;
  const preset = db.query("SELECT * FROM presets WHERE user_id = ? AND id = ?").get(userId, presetId) as Record<string, unknown> | null;
  if (!preset) return null;
  const carrierRow = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT config_json, phase_policy_json, cognition_policy_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as Record<string, unknown> | null
    : null;
  const conservativeExcludedBlockIds = responseCarrierBlockIds(carrierRow ?? {});
  const presetRevision = Number(preset.cache_revision) || 0;
  const reason = projection.review.state === "ready" ? null : projection.review.reasonCode ?? projection.review.state;
  if (projection.config.runtimePolicy) {
    return { presetId, presetRevision, configRevision: projection.configRevision, config: projection.config, taskTemplates: [], review: projection.review, sourceKind: "normalized", reviewReason: reason, conservativeExcludedBlockIds };
  }
  try {
    const authored = readAuthoredCognitionSource(db, userId, presetId, projection, { allowQuarantined: true });
    if (authored?.config.runtimePolicy) return { ...authored, sourceKind: "authored", reviewReason: reason, conservativeExcludedBlockIds };
  } catch {
    // Continue to the bounded legacy carrier below.
  }
  const authoredEnvelope = boundedResponseCarrierObject(carrierRow?.config_json, PORTABLE_PRESET_FIELDS_MAX_BYTES);
  const authoredConfig = authoredEnvelope.config;
  const canonicalRuntimePolicy = authoredConfig && typeof authoredConfig === "object" && !Array.isArray(authoredConfig)
    ? (authoredConfig as Record<string, unknown>).runtimePolicy
    : undefined;
  let runtimePolicy: unknown = canonicalRuntimePolicy;
  if (runtimePolicy !== undefined) {
    try { parseAgentRuntimePolicyV1(runtimePolicy); } catch { runtimePolicy = undefined; }
  }
  runtimePolicy ??= legacyResponseRuntimePolicy(carrierRow ?? {}, parseJsonArray(preset.prompt_order, []), presetRevision);
  if (!runtimePolicy || !projection.config) {
    if (conservativeExcludedBlockIds.length === 0) return null;
    return {
      presetId, presetRevision, configRevision: projection.configRevision,
      config: projection.config,
      taskTemplates: [], review: projection.review, sourceKind: "legacy", reviewReason: reason ?? "legacy_cognition_source",
      conservativeExcludedBlockIds,
    };
  }
  return {
    presetId, presetRevision, configRevision: projection.configRevision,
    config: { ...projection.config, runtimePolicy } as AgentConfigV2,
    taskTemplates: [], review: projection.review, sourceKind: "legacy", reviewReason: reason ?? "legacy_cognition_source",
    conservativeExcludedBlockIds,
  };
}
export function getAgentRuntimeSharedDraft(userId: string, presetId: string): AgentRuntimeSharedDraftResultV1["editor"] | null {
  const db = getDb();
  const preset = db.query("SELECT cache_revision FROM presets WHERE user_id = ? AND id = ?").get(userId, presetId) as { cache_revision?: unknown } | null;
  if (!preset) return null;
  const projection = getPresetAgentConfig(userId, presetId);
  const review = projection?.review ?? { state: "ready" as const, reasonCode: null, unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false };
  const configRevision = projection?.configRevision ?? 0;
  const bindings = projection?.bindings ?? [];
  const authoredRow = tableExists(db, "preset_agent_configs")
    ? db.query("SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get(userId, presetId) as { config_json?: unknown } | null
    : null;
  const authored = parseAuthoredCognitionEnvelope(authoredRow?.config_json);
  const taskTemplates = normalizeDraftList(authored?.taskTemplates, "taskTemplates")
    .map((template) => parseTaskTemplate(template));
  const config = parseAgentConfigV2(normalizeDraftConfig(
    projection?.config ?? createDisabledAgentConfigV2(),
    taskTemplates,
  ));
  parsePortableTaskGraph(taskTemplates, config);
  const reviewAcknowledgements = Array.isArray(authored?.reviewAcknowledgements)
    ? authored.reviewAcknowledgements.filter((value): value is string => typeof value === "string").slice(0, 128)
    : [];
  return {
    presetId,
    presetRevision: Number(preset.cache_revision) || 0,
    configRevision,
    config,
    review: editorReview(review, configRevision, reviewAcknowledgements),
    slotBindings: bindings,
    taskTemplates,
    hostCeilings: getAgentRuntimeHostLimits(),
    reviewAcknowledgements,
  };
}



const STICKY_IMPORT_REVIEW_REASON_CODES: Record<string, true> = {
  foreign_import: true,
  cognition_foreign_authority_blocked: true,
}

function reviewItemIds(review: AgentConfigReviewV1): string[] {
  const ids = [
    ...review.unresolvedSlotIds.map((slotId) => `slot:${slotId}`),
    ...review.staleSlotIds.map((slotId) => `stale-slot:${slotId}`),
  ];
  if (review.state !== "ready" && review.reasonCode != null && STICKY_IMPORT_REVIEW_REASON_CODES[review.reasonCode]) {
    ids.push(`review:${review.reasonCode}`);
  } else if (ids.length === 0 && review.state !== "ready") {
    ids.push(`review:${review.reasonCode ?? review.state}`);
  }
  return [...new Set(ids)].sort();
}

function normalizeReviewAcknowledgements(value: unknown, required: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENTS_INVALID");
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENTS_INVALID");
  const allowed = new Set(required);
  if (ids.some((id) => !allowed.has(id) && id !== "review:foreign_import" && id !== "review:cognition_foreign_authority_blocked")) {
    throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENT_UNKNOWN");
  }
  return [...ids].sort();
}
export interface AgentConfigReviewItemV1 {
  id: string;
  kind: "unresolved_slot" | "stale_slot" | "capability_mismatch" | "disabled_import";
  reasonCode: string;
  action: { kind: "map_slot" | "acknowledge"; ref?: string };
  acknowledged: boolean;
}

export interface AgentRuntimeEditorReviewV1 extends AgentConfigReviewV1 {
  revision: number;
  items: readonly AgentConfigReviewItemV1[];
}

function editorReview(
  review: AgentConfigReviewV1,
  revision: number,
  acknowledgements: readonly string[],
): AgentRuntimeEditorReviewV1 {
  const items: AgentConfigReviewItemV1[] = [];
  for (const slotId of review.unresolvedSlotIds) {
    items.push({
      id: `slot:${slotId}`,
      kind: "unresolved_slot",
      reasonCode: "unresolved_slot",
      action: { kind: "map_slot", ref: slotId },
      acknowledged: review.state === "review_required" && acknowledgements.includes(`slot:${slotId}`),
    });
  }
  for (const slotId of review.staleSlotIds) {
    const capabilityMismatch = review.reasonCode === "capability_mismatch";
    items.push({
      id: `stale-slot:${slotId}`,
      kind: capabilityMismatch ? "capability_mismatch" : "stale_slot",
      reasonCode: capabilityMismatch ? "capability_mismatch" : "stale_slot",
      action: { kind: "map_slot", ref: slotId },
      acknowledged: review.state === "review_required" && acknowledgements.includes(`stale-slot:${slotId}`),
    });
  }
  if (review.state !== "ready" && review.reasonCode != null && STICKY_IMPORT_REVIEW_REASON_CODES[review.reasonCode]) {
    const reasonCode = review.reasonCode;
    const importId = `review:${reasonCode}`;
    if (!items.some((item) => item.id === importId)) {
      items.push({
        id: importId,
        kind: "disabled_import",
        reasonCode,
        action: { kind: "acknowledge" },
        acknowledged: acknowledgements.includes(importId),
      });
    }
  }
  return { ...review, revision, items };
}

function promptBlockRevision(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 1;
  const raw = (value as Record<string, unknown>).revision;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 1;
}
function promptBlockSemanticValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { revision: _revision, ...semantic } = value as Record<string, unknown>;
  return semantic;
}
function loomReferencesMatchPromptOrder(
  config: AgentConfigV2,
  presetRevision: number,
  promptOrder: readonly unknown[],
): boolean {
  const sourceMatches = (source: { readonly blockId: string; readonly presetRevision: number; readonly blockRevision: number; readonly promptOrder: number }): boolean => {
    const value = promptOrder[source.promptOrder];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return row.id === source.blockId
      && row.marker !== "category"
      && source.presetRevision === presetRevision
      && source.blockRevision === promptBlockRevision(value);
  };
  const runtimePolicy = config.runtimePolicy;
  if (!runtimePolicy) return true;
  for (const bucket of ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"] as const) {
    for (const entry of runtimePolicy.loomPolicy?.[bucket] ?? []) {
      if (!sourceMatches(entry.source)) return false;
    }
  }
  for (const phase of runtimePolicy.phases) {
    for (const source of phase.instructionRefs) {
      if (!sourceMatches(source)) return false;
    }
    for (const subset of phase.childInstructionSubsets) {
      for (const source of subset.instructionRefs) {
        if (!sourceMatches(source)) return false;
      }
    }
  }
  return true;
}
function rebaseValidLoomSourcesToCommittedRevision(
  config: AgentConfigV2,
  expectedPresetRevision: number,
  committedPresetRevision: number,
  persistedPromptOrder: readonly unknown[],
  promptOrder: readonly unknown[],
): AgentConfigV2 {
  const runtimePolicy = config.runtimePolicy;
  if (!runtimePolicy) return config;
  if (!Number.isSafeInteger(committedPresetRevision) || committedPresetRevision < 0) return config;
  type IndexedPromptBlock = {
    readonly id: string;
    readonly revision: number;
    readonly category: boolean;
    readonly value: unknown;
  };
  const indexBlocks = (values: readonly unknown[]): Array<IndexedPromptBlock | null> => values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) return null;
    return {
      id: row.id,
      revision: promptBlockRevision(value),
      category: row.marker === "category",
      value: promptBlockSemanticValue(value),
    };
  });
  const persistedBlocks = indexBlocks(persistedPromptOrder);
  const blocks = indexBlocks(promptOrder);
  const rebaseSource = (source: LoomPolicySourceV1): LoomPolicySourceV1 => {
    const block = blocks[source.promptOrder];
    if (!block || block.id !== source.blockId || block.category) return source;
    if (source.blockRevision !== block.revision) return source;
    if (source.presetRevision !== expectedPresetRevision) return source;
    const persisted = persistedBlocks[source.promptOrder];
    const unchanged = persisted !== undefined
      && persisted !== null
      && persisted.id === block.id
      && persisted.revision === block.revision
      && sameJsonValue(persisted.value, block.value);
    return unchanged ? { ...source, presetRevision: committedPresetRevision } : source;
  };
  const loomPolicy = runtimePolicy.loomPolicy == null
    ? runtimePolicy.loomPolicy
    : {
        ...runtimePolicy.loomPolicy,
        workPolicy: runtimePolicy.loomPolicy.workPolicy.map((entry) => ({ ...entry, source: rebaseSource(entry.source) })),
        workspaceUsage: runtimePolicy.loomPolicy.workspaceUsage.map((entry) => ({ ...entry, source: rebaseSource(entry.source) })),
        completionCriteria: runtimePolicy.loomPolicy.completionCriteria.map((entry) => ({ ...entry, source: rebaseSource(entry.source) })),
        renderPolicy: runtimePolicy.loomPolicy.renderPolicy.map((entry) => ({ ...entry, source: rebaseSource(entry.source) })),
      };
  return {
    ...config,
    runtimePolicy: {
      ...runtimePolicy,
      loomPolicy,
      phases: runtimePolicy.phases.map((phase) => ({
        ...phase,
        instructionRefs: phase.instructionRefs.map(rebaseSource),
        childInstructionSubsets: phase.childInstructionSubsets.map((subset) => ({
          ...subset,
          instructionRefs: subset.instructionRefs.map(rebaseSource),
        })),
      })),
    },
  };
}

/**
 * Ordinary preset revision advances invalidate immutable Loom provenance.
 * Quarantine the normalized config whenever any exact source no longer
 * matches the newly committed preset and prompt-block revisions.
 */
export function quarantineAgentConfigForPresetRevisionWithDb(
  db: Database,
  userId: string,
  presetId: string,
  nextPresetRevision: number,
  promptOrder: readonly unknown[],
): boolean {
  if (!tableExists(db, "preset_agent_configs")) return false;
  const row = db.query(
    "SELECT config_json, state, review_code FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
  ).get(userId, presetId) as { config_json?: unknown; state?: unknown; review_code?: unknown } | null;
  if (!row) return false;
  const authored = parseJsonObject(row.config_json);
  const rawConfig = authored.config;
  if (rawConfig === undefined) return false;
  let config: AgentConfigV2;
  try {
    config = parseAgentConfigV2(rawConfig);
  } catch {
    return false;
  }
  const loomPolicy = config.runtimePolicy?.loomPolicy;
  const hasCustomPhaseSources = (config.runtimePolicy?.phases.length ?? 0) > 0;
  if (!loomPolicy && !hasCustomPhaseSources) return false;
  const invalid = !loomReferencesMatchPromptOrder(config, nextPresetRevision, promptOrder);
  if (!invalid || row.state === "repair_required" && row.review_code === "loom_reference_repair_required") return false;
  const now = Math.floor(Date.now() / 1000);
  const result = db.query(
    "UPDATE preset_agent_configs SET state = 'repair_required', review_code = 'loom_reference_repair_required', review_acknowledged = 0, config_revision = config_revision + 1, updated_at = ? WHERE user_id = ? AND preset_id = ?",
  ).run(now, userId, presetId);
  return result.changes === 1;
}


export function saveAgentRuntimeSharedDraft(userId: string, presetId: string, draft: AgentRuntimeSharedDraftV1): AgentRuntimeSharedDraftResultV1 {
  const db = getDb();
  return db.transaction(() => {
    const preset = assertPresetOwned(db, userId, presetId);
    const expectedPresetRevision = draft.expectedPresetRevision;
    if (!Number.isSafeInteger(expectedPresetRevision) || (expectedPresetRevision as number) < 0) throw new Error("PRESET_REVISION_REQUIRED");
    const actualPresetRevision = Number(preset.cache_revision) || 0;
    if (expectedPresetRevision !== actualPresetRevision) throw new Error("PRESET_REVISION_CONFLICT");
    if (!Number.isSafeInteger(draft.expectedConfigRevision) || (draft.expectedConfigRevision as number) < 0) throw new Error("AGENT_CONFIG_REVISION_REQUIRED");
    const currentProjection = readNormalizedProjection(db, userId, presetId);
    const inheritedReview = currentProjection?.review ?? { state: "ready" as const, reasonCode: null, unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false };
    const actualConfigRevision = currentProjection?.configRevision ?? 0;
    if (draft.expectedConfigRevision !== actualConfigRevision) {
      throw new AgentConfigRevisionConflictError(presetId, draft.expectedConfigRevision as number, actualConfigRevision);
    }
    const taskTemplates = normalizeDraftList(draft.taskTemplates, "taskTemplates");
    const config = normalizeDraftConfig(draft.config, taskTemplates);
    const slotBindings = (draft.slotBindings ?? []).map((binding, index) => {
      if (typeof binding !== "object" || binding === null || Array.isArray(binding)) throw new Error(`slotBindings[${index}] must be an object`);
      const row = binding as Record<string, unknown>;
      for (const key of Object.keys(row)) if (key !== "slotId" && key !== "connectionId") throw new Error("AGENT_RUNTIME_DRAFT_UNKNOWN_FIELD");
      const slotId = row.slotId;
      const connectionId = row.connectionId ?? null;
      if (typeof slotId !== "string") throw new Error(`slotBindings[${index}].slotId is required`);
      if (connectionId !== null && typeof connectionId !== "string") throw new Error(`slotBindings[${index}].connectionId is invalid`);
      return { slotId, connectionId: connectionId as string | null };
    });
    const promptOrder = draft.promptOrder;
    if (!Array.isArray(promptOrder)) throw new Error("promptOrder must be an array");
    const persistedAuthoredRow = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(userId, presetId) as { config_json?: unknown } | null;
    const persistedAuthored = parseJsonObject(persistedAuthoredRow?.config_json);
    const persistedReviewAcknowledgements = Array.isArray(persistedAuthored.reviewAcknowledgements)
      ? persistedAuthored.reviewAcknowledgements.filter((value): value is string => typeof value === "string")
      : [];
    const parsedConfig = parseAgentConfigV2(config);
    const persistedPromptOrder = parseJsonArray(preset.prompt_order);
    const promptOrderChanged = !sameJsonValue(promptOrder, persistedPromptOrder);
    const currentConfig = currentProjection?.config ?? createDisabledAgentConfigV2();
    const currentBindings = (currentProjection?.bindings ?? []).map(({ slotId, connectionId }) => ({ slotId, connectionId })).sort((a, b) => a.slotId.localeCompare(b.slotId));
    const requestedBindings = slotBindings.map(({ slotId, connectionId }) => ({ slotId, connectionId })).sort((a, b) => a.slotId.localeCompare(b.slotId));
    const persistedTaskTemplates = Array.isArray(persistedAuthored.taskTemplates) ? persistedAuthored.taskTemplates.slice(0, 128) : [];
    const persistedReviewAcknowledgementsCanonical = [...persistedReviewAcknowledgements].sort();
    const configPayloadUnchanged = sameJsonValue(parsedConfig, currentConfig)
      && sameJsonValue(requestedBindings, currentBindings)
      && sameJsonValue(taskTemplates, persistedTaskTemplates);
    let trueNoOp = false;
    if (!promptOrderChanged && configPayloadUnchanged && inheritedReview.state === "ready") {
      const requestedAcknowledgements = normalizeReviewAcknowledgements(draft.reviewAcknowledgements, reviewItemIds(inheritedReview));
      trueNoOp = sameJsonValue(requestedAcknowledgements, persistedReviewAcknowledgementsCanonical);
    }
    if (trueNoOp) {
      const projection = currentProjection ?? {
        config: currentConfig,
        review: inheritedReview,
        configRevision: actualConfigRevision,
        bindingRevision: 0,
        bindings: [],
      };
      const editor = {
        presetId,
        presetRevision: actualPresetRevision,
        configRevision: actualConfigRevision,
        config: projection.config,
        review: editorReview(projection.review, projection.configRevision, persistedReviewAcknowledgements),
        slotBindings: projection.bindings,
        taskTemplates: persistedTaskTemplates,
        hostCeilings: getAgentRuntimeHostLimits(),
        reviewAcknowledgements: persistedReviewAcknowledgements,
      };
      return { preset: rowToPreset(preset, projection), editor };
    }
    const submittedLoomReferenceRepairRequired = promptOrderChanged
      && !loomReferencesMatchPromptOrder(parsedConfig, actualPresetRevision, persistedPromptOrder);
    const committedPresetRevision = promptOrderChanged ? actualPresetRevision + 1 : actualPresetRevision;
    const committedConfig = promptOrderChanged
      ? rebaseValidLoomSourcesToCommittedRevision(parsedConfig, actualPresetRevision, committedPresetRevision, persistedPromptOrder, promptOrder)
      : parsedConfig;
    if (promptOrderChanged) {
      const now = Math.floor(Date.now() / 1000);
      const promptResult = db.query("UPDATE presets SET prompt_order = ?, updated_at = ?, cache_revision = cache_revision + 1 WHERE id = ? AND user_id = ? AND cache_revision = ?").run(JSON.stringify(promptOrder), now, presetId, userId, actualPresetRevision);
      if (promptResult.changes !== 1) throw new Error("PRESET_REVISION_CONFLICT");
    }
    const connectionCache = new Map<string, ResolvedConcreteConnectionV1 | null>();
    const capabilityMismatchSlotIds: string[] = [];
    parsePortableTaskGraph(taskTemplates, committedConfig);
    for (const binding of slotBindings) {
      const slot = committedConfig.connectionSlots.find((candidate) => candidate.id === binding.slotId);
      if (!slot) continue;
      const validation = validateBindingCapabilities(userId, slot, binding.connectionId, connectionCache);
      if (validation.reviewCode === "capability_mismatch") capabilityMismatchSlotIds.push(binding.slotId);
    }
    capabilityMismatchSlotIds.sort();
    const replacementCognition = cognitionReview(userId, presetId, committedConfig, "local", false);
    const repairStillRequired = inheritedReview.state === "repair_required" && replacementCognition.state !== "ready";
    const preserveReview = inheritedReview.state === "review_required"
      && inheritedReview.reasonCode != null
      && STICKY_IMPORT_REVIEW_REASON_CODES[inheritedReview.reasonCode] === true;
    const candidateReview = {
      ...inheritedReview,
      state: submittedLoomReferenceRepairRequired || repairStillRequired
        ? "repair_required" as const
        : capabilityMismatchSlotIds.length > 0 || preserveReview
          ? "review_required" as const
          : "ready" as const,
      reasonCode: submittedLoomReferenceRepairRequired
        ? "loom_reference_repair_required"
        : repairStillRequired
          ? inheritedReview.reasonCode
          : preserveReview
            ? inheritedReview.reasonCode
            : capabilityMismatchSlotIds.length > 0
              ? "capability_mismatch"
              : null,
      unresolvedSlotIds: slotBindings.filter((binding) => binding.connectionId === null).map((binding) => binding.slotId),
      staleSlotIds: capabilityMismatchSlotIds,
    };
    const requiredReviewIds = reviewItemIds(candidateReview);
    const allowedReviewIds = [...new Set([
      ...requiredReviewIds,
      ...reviewItemIds(inheritedReview),
      ...persistedReviewAcknowledgements,
    ])];
    const acceptedReviewAcknowledgements = normalizeReviewAcknowledgements(draft.reviewAcknowledgements, allowedReviewIds);
    const retainedReviewIds = new Set([
      ...requiredReviewIds,
      "review:foreign_import",
      "review:cognition_foreign_authority_blocked",
    ]);
    const reviewAcknowledgements = acceptedReviewAcknowledgements.filter((id) => retainedReviewIds.has(id));
    if (candidateReview.state === "repair_required" && reviewAcknowledgements.length > 0) {
      throw new Error("AGENT_REVIEW_ACKNOWLEDGEMENT_NOT_ALLOWED");
    }
    const reviewAcknowledged = requiredReviewIds.every((id) => reviewAcknowledgements.includes(id));
    const hasUnresolvedReviewItems = candidateReview.unresolvedSlotIds.length > 0 || candidateReview.staleSlotIds.length > 0;
    const requestedReviewState = candidateReview.state === "repair_required"
      ? "repair_required" as const
      : candidateReview.state === "review_required"
        && (hasUnresolvedReviewItems || !reviewAcknowledged || replacementCognition.state !== "ready")
        ? "review_required" as const
        : "ready" as const;
    const requestedReasonCode = requestedReviewState === "ready" ? null : candidateReview.reasonCode;
    const authoredDraft = { config: committedConfig, taskTemplates, reviewAcknowledgements };
    const projection = writeAgentConfigWithDb(db, userId, presetId, {
      config: committedConfig,
      bindings: slotBindings,
      expectedConfigRevision: draft.expectedConfigRevision,
      review: {
        state: requestedReviewState,
        reasonCode: requestedReasonCode,
        unresolvedSlotIds: candidateReview.unresolvedSlotIds,
        staleSlotIds: candidateReview.staleSlotIds,
        acknowledged: reviewAcknowledged && !hasUnresolvedReviewItems,
      },
      authoredDraft,
    });
    const updated = assertPresetOwned(db, userId, presetId);
    const editor = {
      presetId,
      presetRevision: Number(updated.cache_revision) || actualPresetRevision,
      configRevision: projection.configRevision,
      config: projection.config,
      review: editorReview(projection.review, projection.configRevision, reviewAcknowledgements),
      slotBindings: projection.bindings,
      taskTemplates,
      hostCeilings: getAgentRuntimeHostLimits(),
      reviewAcknowledgements,
    };
    return { preset: rowToPreset(updated, projection), editor };
  })();
}
