import {
  AGENT_COGNITION_VERSION,
  AgentCognitionValidationError,
  COGNITION_MAX_BLOCK_REFS_PER_SECTION,
  COGNITION_MAX_BLOCK_REFS_TOTAL,
  COGNITION_MAX_ID_BYTES,
  COGNITION_MAX_LIST_BYTES,
  COGNITION_MAX_LIST_ITEMS,
  COGNITION_MAX_PREDICATE_DEPTH,
  COGNITION_MAX_PREDICATE_NODES,
  COGNITION_MAX_SOURCE_BLOCKS,
  COGNITION_MAX_STRING_BYTES,
  COGNITION_MAX_TASK_TEMPLATES,
  type CognitionActivationPointV1,
  type CognitionActivationResultV1,
  type CognitionActivationRootsV1,
  type CognitionActivationStateV1,
  type CognitionCompletionResultV1,
  type CognitionEvaluationContextV1,
  type CognitionFrozenSourceRevisionsV1,
  type CognitionGenerationType,
  type CognitionGraphV1,
  type CognitionLoomBlockRefV1,
  type CognitionPhase,
  type CognitionPolicyRefsV1,
  type CognitionPredicateOperator,
  type CognitionPredicateV1,
  type CognitionScalar,
  type CognitionSourceBlockV1,
  type CognitionSourceSnapshotV1,
  type CognitionTaskTransition,
  type CognitionTaskTransitionResultV1,
  type CognitionValue,
  type FrozenCognitionGraphV1,
  type TaskTemplateV1,
  type CognitionWorkspaceCasV1,
  LOOM_POLICY_BUCKETS,
  LOOM_POLICY_CHECKPOINTS,
  LOOM_POLICY_DESTINATIONS,
  LOOM_POLICY_VERSION,
  type LoomPolicyBucketV1,
  type LoomPolicyBucketsV1,
  type LoomPolicyCheckpointV1,
  type LoomPolicyConditionResultV1,
  type LoomPolicyDestinationV1,
  type LoomPolicyEntryV1,
  type LoomPolicySourceV1,
  type LoomPromptInspectionBlockV1,
  type LoomPromptInspectionInputV1,
  type LoomPromptInspectionItemV1,
  type LoomPromptInspectionOutcomeV1,
  type LoomPromptInspectionV1,
  type LoomResponsePolicyOmissionV1,
} from "../types/agent-cognition";
import {
  parseAgentRuntimePolicyV1,
  type AgentRuntimePolicyV1,
} from "../types/agents";
import { compareUtf8 } from "../utils/utf8-order";

const UTF8_ENCODER = new TextEncoder();
const OBJECT_PROTO = Object.prototype;
type PlainRecord = Record<string, unknown>;
type ParseBudget = { predicateNodes: number; listBytes: number };

const GENERATION_TYPES: readonly CognitionGenerationType[] = ["normal", "continue", "regenerate", "swipe"];
const PHASES: readonly CognitionPhase[] = [
  "ASSEMBLE", "WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING", "COMMITTED",
  "COMMIT_FAILED", "EXHAUSTED", "FAILED", "CANCELLED", "TIMED_OUT",
];
const TASK_TRANSITIONS: readonly CognitionTaskTransition[] = ["pending", "active", "blocked", "completed", "cancelled", "failed"];
const PREDICATE_KINDS = ["all", "any", "not", "generation_type", "phase", "preset_variable", "participant_fact", "tool_available", "task_transition"] as const;
const PREDICATE_OPERATORS = ["equals", "in", "includes", "present"] as const;

function fail(code: AgentCognitionValidationError["code"], path: string, message: string): never {
  throw new AgentCognitionValidationError(code, path, message);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === OBJECT_PROTO || prototype === null;
}

export function parseCanonicalRuntimePolicyV1(value: unknown, path = "runtimePolicy"): AgentRuntimePolicyV1 | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) fail("invalid_type", path, "must be a plain object or null");
  try {
    return parseAgentRuntimePolicyV1(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid runtime policy";
    fail(message.includes("must be a plain object") ? "invalid_type" : "invalid_value", path, message);
  }
}

function record(value: unknown, path: string): PlainRecord {
  if (!isPlainRecord(value)) fail("invalid_type", path, "must be a plain object");
  return value;
}

function exactKeys(value: PlainRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail("unknown_key", `${path}.${key}`, "unknown key");
  }
}

function has(value: PlainRecord, key: string): boolean {
  return OBJECT_PROTO.hasOwnProperty.call(value, key);
}

function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function compareNumber(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function containsForbiddenMarkup(value: string): boolean {
  return value.includes("{{") || value.includes("}}");
}

function ensureSafeText(value: unknown, path: string, maxBytes = COGNITION_MAX_STRING_BYTES): string {
  if (typeof value !== "string") fail("invalid_type", path, "must be a string");
  if (utf8Bytes(value) > maxBytes) fail("limit_exceeded", path, `must be at most ${maxBytes} UTF-8 bytes`);
  if (containsForbiddenMarkup(value)) fail("invalid_value", path, "macros are not allowed");
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)) {
      fail("invalid_value", path, "contains a control character");
    }
  }
  return value;
}

function ensureId(value: unknown, path: string): string {
  const result = ensureSafeText(value, path, COGNITION_MAX_ID_BYTES);
  if (result.length === 0) fail("invalid_value", path, "must not be empty");
  for (const character of result) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) fail("invalid_value", path, "must not contain whitespace");
  }
  return result;
}

function ensureBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid_type", path, "must be a boolean");
  return value;
}

function ensureRevision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid_type", path, "must be a non-negative safe integer");
  return value;
}

function ensureEnum<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("invalid_value", path, "contains an unsupported value");
  return value as T;
}

function ensureArray(value: unknown, path: string, maxItems = COGNITION_MAX_LIST_ITEMS): unknown[] {
  if (!Array.isArray(value)) fail("invalid_type", path, "must be an array");
  if (value.length > maxItems) fail("limit_exceeded", path, `must contain at most ${maxItems} items`);
  return value;
}

function accountListBytes(budget: ParseBudget, value: string, path: string): void {
  budget.listBytes += utf8Bytes(value);
  if (budget.listBytes > COGNITION_MAX_LIST_BYTES) fail("limit_exceeded", path, `list strings must total at most ${COGNITION_MAX_LIST_BYTES} UTF-8 bytes`);
}

function ensureScalar(value: unknown, path: string, budget?: ParseBudget): CognitionScalar {
  if (typeof value === "string") {
    const text = ensureSafeText(value, path);
    if (budget) accountListBytes(budget, text, path);
    return text;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_value", path, "must be finite");
    return value;
  }
  if (typeof value === "boolean") return value;
  fail("invalid_type", path, "must be a string, finite number, or boolean");
}

function parseValue(value: unknown, path: string, budget: ParseBudget): CognitionValue {
  if (!Array.isArray(value)) return ensureScalar(value, path);
  const values = ensureArray(value, path);
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (typeof item !== "string") fail("invalid_type", `${path}[${index}]`, "array values must be strings");
    const text = ensureSafeText(item, `${path}[${index}]`);
    accountListBytes(budget, text, `${path}[${index}]`);
    result.push(text);
  }
  return result;
}

function valueKey(value: CognitionValue): string {
  if (Array.isArray(value)) return `array:${value.length}:${value.map((item) => `${utf8Bytes(item)}:${item}`).join("")}`;
  if (typeof value === "string") return `string:${utf8Bytes(value)}:${value}`;
  if (typeof value === "number") return `number:${String(value)}`;
  return `boolean:${value ? "1" : "0"}`;
}

function parseScalarList(value: unknown, path: string, budget: ParseBudget): CognitionScalar[] {
  const values = ensureArray(value, path);
  if (values.length === 0) fail("invalid_value", path, "must not be empty");
  const result: CognitionScalar[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const parsed = ensureScalar(values[index], `${path}[${index}]`, budget);
    const key = valueKey(parsed);
    if (seen.has(key)) fail("invalid_value", `${path}[${index}]`, "duplicate value");
    seen.add(key);
    result.push(parsed);
  }
  result.sort((left, right) => compareUtf8(valueKey(left), valueKey(right)));
  return result;
}

function isCognitionScalar(value: CognitionValue): value is CognitionScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarEqual(left: CognitionScalar, right: CognitionScalar): boolean {
  return typeof left === typeof right && left === right;
}

function valueEqual(left: CognitionValue, right: CognitionValue): boolean {
  if (!isCognitionScalar(left) || !isCognitionScalar(right)) {
    if (isCognitionScalar(left) || isCognitionScalar(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  return scalarEqual(left, right);
}

function stablePredicateKey(predicate: CognitionPredicateV1): string {
  switch (predicate.kind) {
    case "all": return `all:${predicate.children.length}:${predicate.children.map(stablePredicateKey).join("")}`;
    case "any": return `any:${predicate.children.length}:${predicate.children.map(stablePredicateKey).join("")}`;
    case "not": return `not:${stablePredicateKey(predicate.child)}`;
    case "generation_type": return `generation_type:${predicate.value}`;
    case "phase": return `phase:${predicate.value}`;
    case "preset_variable":
    case "participant_fact": {
      const value = "value" in predicate
        ? valueKey(predicate.value)
        : "values" in predicate ? predicate.values.map(valueKey).join("|") : "";
      return `${predicate.kind}:${predicate.name}:${predicate.operator}:${value}`;
    }
    case "tool_available": return `tool_available:${predicate.toolId}:${predicate.available ? "1" : "0"}`;
    case "task_transition": return `task_transition:${predicate.taskId}:${predicate.transition}`;
  }
}

function parsePredicateOperator(value: unknown, path: string): CognitionPredicateOperator {
  return ensureEnum(value, PREDICATE_OPERATORS, path);
}

function parseVariablePredicate(value: PlainRecord, path: string, kind: "preset_variable" | "participant_fact", budget: ParseBudget): CognitionPredicateV1 {
  exactKeys(value, ["kind", "name", "operator", "value", "values"], path);
  ensureEnum(value.kind, [kind], `${path}.kind`);
  const name = ensureId(value.name, `${path}.name`);
  const operator = parsePredicateOperator(value.operator, `${path}.operator`);
  if (operator === "present") {
    if (has(value, "value") || has(value, "values")) fail("unknown_key", path, "present predicates do not take a value");
    return { kind, name, operator } as CognitionPredicateV1;
  }
  if (operator === "in") {
    if (!has(value, "values") || has(value, "value")) fail("invalid_value", path, "in predicates require values only");
    return { kind, name, operator, values: parseScalarList(value.values, `${path}.values`, budget) } as CognitionPredicateV1;
  }
  if (!has(value, "value") || has(value, "values")) fail("invalid_value", path, `${operator} predicates require value only`);
  const parsed = operator === "equals" ? parseValue(value.value, `${path}.value`, budget) : ensureScalar(value.value, `${path}.value`, budget);
  return { kind, name, operator, value: parsed } as CognitionPredicateV1;
}

function parsePredicate(value: unknown, path: string, budget: ParseBudget, depth: number): CognitionPredicateV1 {
  if (depth > COGNITION_MAX_PREDICATE_DEPTH) fail("limit_exceeded", path, `predicate depth must be at most ${COGNITION_MAX_PREDICATE_DEPTH}`);
  budget.predicateNodes += 1;
  if (budget.predicateNodes > COGNITION_MAX_PREDICATE_NODES) fail("limit_exceeded", path, `predicate nodes must total at most ${COGNITION_MAX_PREDICATE_NODES}`);
  const object = record(value, path);
  const kind = ensureEnum(object.kind, PREDICATE_KINDS, `${path}.kind`);
  switch (kind) {
    case "all":
    case "any": {
      exactKeys(object, ["kind", "children"], path);
      const children = ensureArray(object.children, `${path}.children`);
      const parsed = children.map((child, index) => parsePredicate(child, `${path}.children[${index}]`, budget, depth + 1));
      parsed.sort((left, right) => compareUtf8(stablePredicateKey(left), stablePredicateKey(right)));
      return { kind, children: parsed };
    }
    case "not":
      exactKeys(object, ["kind", "child"], path);
      return { kind, child: parsePredicate(object.child, `${path}.child`, budget, depth + 1) };
    case "generation_type":
      exactKeys(object, ["kind", "value"], path);
      return { kind, value: ensureEnum(object.value, GENERATION_TYPES, `${path}.value`) };
    case "phase":
      exactKeys(object, ["kind", "value"], path);
      return { kind, value: ensureEnum(object.value, PHASES, `${path}.value`) };
    case "preset_variable": return parseVariablePredicate(object, path, kind, budget);
    case "participant_fact": return parseVariablePredicate(object, path, kind, budget);
    case "tool_available":
      exactKeys(object, ["kind", "toolId", "available"], path);
      return { kind, toolId: ensureId(object.toolId, `${path}.toolId`), available: ensureBoolean(object.available, `${path}.available`) };
    case "task_transition":
      exactKeys(object, ["kind", "taskId", "transition"], path);
      return { kind, taskId: ensureId(object.taskId, `${path}.taskId`), transition: ensureEnum(object.transition, TASK_TRANSITIONS, `${path}.transition`) };
  }
}

/** Parse and canonicalize a closed predicate AST. */
export function parseCognitionPredicate(value: unknown): CognitionPredicateV1 {
  return parsePredicate(value, "predicate", { predicateNodes: 0, listBytes: 0 }, 1);
}
export const parseCognitionPredicateV1 = parseCognitionPredicate;
export const validateCognitionPredicateV1 = parseCognitionPredicate;
export const validateCognitionPredicate = parseCognitionPredicate;

function loomOccurrenceKey(blockId: string, promptOrder: number): string {
  return `${blockId.length}:${blockId}:${promptOrder}`;
}

function parseBlockRef(value: unknown, path: string, budget: ParseBudget): CognitionLoomBlockRefV1 {
  const object = record(value, path);
  exactKeys(object, ["blockId", "expectedPresetRevision", "expectedBlockRevision", "promptOrder"], path);
  const blockId = ensureId(object.blockId, `${path}.blockId`);
  accountListBytes(budget, blockId, `${path}.blockId`);
  return {
    blockId,
    expectedPresetRevision: ensureRevision(object.expectedPresetRevision, `${path}.expectedPresetRevision`),
    expectedBlockRevision: ensureRevision(object.expectedBlockRevision, `${path}.expectedBlockRevision`),
    promptOrder: ensureRevision(object.promptOrder, `${path}.promptOrder`),
  };
}

function parseBlockRefs(value: unknown, path: string, budget: ParseBudget): CognitionLoomBlockRefV1[] {
  const values = ensureArray(value, path, COGNITION_MAX_BLOCK_REFS_PER_SECTION);
  const result: CognitionLoomBlockRefV1[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const ref = parseBlockRef(values[index], `${path}[${index}]`, budget);
    const occurrenceKey = loomOccurrenceKey(ref.blockId, ref.promptOrder);
    if (seen.has(occurrenceKey)) fail("duplicate_id", `${path}[${index}].blockId`, "duplicate block occurrence reference");
    seen.add(occurrenceKey);
    result.push(ref);
  }
  return result;
}

function parsePolicyRefsWithBudget(value: unknown, budget: ParseBudget): CognitionPolicyRefsV1 {
  const object = record(value, "policies");
  exactKeys(object, ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"], "policies");
  const result = {
    workPolicy: parseBlockRefs(object.workPolicy, "policies.workPolicy", budget),
    workspaceUsage: parseBlockRefs(object.workspaceUsage, "policies.workspaceUsage", budget),
    completionCriteria: parseBlockRefs(object.completionCriteria, "policies.completionCriteria", budget),
    renderPolicy: parseBlockRefs(object.renderPolicy, "policies.renderPolicy", budget),
  } satisfies CognitionPolicyRefsV1;
  const total = result.workPolicy.length + result.workspaceUsage.length + result.completionCriteria.length + result.renderPolicy.length;
  if (total > COGNITION_MAX_BLOCK_REFS_TOTAL) fail("limit_exceeded", "policies", `block references must total at most ${COGNITION_MAX_BLOCK_REFS_TOTAL}`);
  return result;
}

/** Parse the four ordered Loom block-reference sections. */
export function parseCognitionPolicyRefs(value: unknown): CognitionPolicyRefsV1 {
  return parsePolicyRefsWithBudget(value, { predicateNodes: 0, listBytes: 0 });
}

export const LOOM_BUCKET_DESTINATION: Readonly<Record<LoomPolicyBucketV1, LoomPolicyDestinationV1>> = Object.freeze({
  workPolicy: "root_work",
  workspaceUsage: "root_work",
  completionCriteria: "completion_handoff",
  renderPolicy: "render",
});
export const LOOM_BUCKET_CHECKPOINT: Readonly<Record<LoomPolicyBucketV1, LoomPolicyCheckpointV1>> = Object.freeze({
  workPolicy: "WORK",
  workspaceUsage: "WORK",
  completionCriteria: "PREPARE_COMMIT",
  renderPolicy: "RENDER",
});
const LOOM_CHECKPOINT_RANK: Readonly<Record<LoomPolicyCheckpointV1, number>> = Object.freeze({ ASSEMBLE: 0, WORK: 1, PREPARE_COMMIT: 2, RENDER: 3 });

function parseLoomPolicySource(value: unknown, path: string): LoomPolicySourceV1 {
  const object = record(value, path);
  exactKeys(object, ["kind", "blockId", "presetRevision", "blockRevision", "promptOrder"], path);
  ensureEnum(object.kind, ["loom_block"] as const, `${path}.kind`);
  return {
    kind: "loom_block",
    blockId: ensureId(object.blockId, `${path}.blockId`),
    presetRevision: ensureRevision(object.presetRevision, `${path}.presetRevision`),
    blockRevision: ensureRevision(object.blockRevision, `${path}.blockRevision`),
    promptOrder: ensureRevision(object.promptOrder, `${path}.promptOrder`),
  };
}

function parseLoomPolicyEntry(value: unknown, path: string, bucket: LoomPolicyBucketV1, budget: ParseBudget): LoomPolicyEntryV1 {
  const object = record(value, path);
  exactKeys(object, ["version", "id", "source", "destination", "checkpoint", "required", "visibility", "condition"], path);
  if (object.version !== LOOM_POLICY_VERSION) fail("invalid_value", `${path}.version`, "unsupported Loom policy version");
  const destination = ensureEnum(object.destination, LOOM_POLICY_DESTINATIONS, `${path}.destination`);
  if (destination !== LOOM_BUCKET_DESTINATION[bucket]) fail("invalid_value", `${path}.destination`, `destination is not valid for ${bucket}`);
  const checkpoint = ensureEnum(object.checkpoint, LOOM_POLICY_CHECKPOINTS, `${path}.checkpoint`);
  if (checkpoint !== LOOM_BUCKET_CHECKPOINT[bucket]) fail("invalid_value", `${path}.checkpoint`, `checkpoint is not valid for ${bucket}`);
  const required = ensureBoolean(object.required, `${path}.required`);
  ensureEnum(object.visibility, ["work_only"] as const, `${path}.visibility`);
  return {
    version: LOOM_POLICY_VERSION,
    id: ensureId(object.id, `${path}.id`),
    source: parseLoomPolicySource(object.source, `${path}.source`),
    destination,
    checkpoint,
    required,
    visibility: "work_only",
    ...(has(object, "condition") ? { condition: parsePredicate(object.condition, `${path}.condition`, budget, 1) } : {}),
  };
}

function sortLoomPolicyEntries(entries: readonly LoomPolicyEntryV1[]): LoomPolicyEntryV1[] {
  return [...entries].sort((left, right) => compareNumber(left.source.promptOrder, right.source.promptOrder) || compareUtf8(left.source.blockId, right.source.blockId) || compareUtf8(left.id, right.id));
}

export function parseLoomPolicyBuckets(value: unknown): LoomPolicyBucketsV1 {
  const object = record(value, "policies");
  exactKeys(object, ["version", ...LOOM_POLICY_BUCKETS], "policies");
  if (object.version !== LOOM_POLICY_VERSION) fail("invalid_value", "policies.version", "unsupported Loom policy version");
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const parsed = Object.fromEntries(LOOM_POLICY_BUCKETS.map((bucket) => [
    bucket,
    sortLoomPolicyEntries(ensureArray(object[bucket], `policies.${bucket}`, COGNITION_MAX_BLOCK_REFS_PER_SECTION).map((entry, index) => parseLoomPolicyEntry(entry, `policies.${bucket}[${index}]`, bucket, budget))),
  ])) as Record<LoomPolicyBucketV1, LoomPolicyEntryV1[]>;
  const ids = LOOM_POLICY_BUCKETS.flatMap((bucket) => parsed[bucket].map((entry) => entry.id));
  assertUniqueIds(ids, "policies");
  if (ids.length > COGNITION_MAX_BLOCK_REFS_TOTAL) fail("limit_exceeded", "policies", `entries must total at most ${COGNITION_MAX_BLOCK_REFS_TOTAL}`);
  return deepFreeze({ version: LOOM_POLICY_VERSION, workPolicy: parsed.workPolicy, workspaceUsage: parsed.workspaceUsage, completionCriteria: parsed.completionCriteria, renderPolicy: parsed.renderPolicy });
}
export const parseLoomPolicyBucketsV1 = parseLoomPolicyBuckets;

function loomSourceForRef(ref: CognitionLoomBlockRefV1, source: CognitionSourceSnapshotV1, path: string): LoomPolicySourceV1 {
  const block = source.blocks.find((candidate) => candidate.promptOrder === ref.promptOrder);
  if (!block || block.blockId !== ref.blockId) fail("missing_reference", `${path}.blockId`, "Loom block occurrence is missing from the source snapshot");
  if (ref.expectedPresetRevision !== source.presetRevision) fail("revision_mismatch", `${path}.expectedPresetRevision`, "preset revision does not match the frozen source");
  if (ref.expectedBlockRevision !== block.revision) fail("revision_mismatch", `${path}.expectedBlockRevision`, "block revision does not match the frozen source");
  return { kind: "loom_block", blockId: block.blockId, presetRevision: source.presetRevision, blockRevision: block.revision, promptOrder: block.promptOrder };
}

function policyEntriesFromRefs(refs: CognitionPolicyRefsV1, source: CognitionSourceSnapshotV1): LoomPolicyBucketsV1 {
  const buckets = Object.fromEntries(LOOM_POLICY_BUCKETS.map((bucket) => [
    bucket,
    sortLoomPolicyEntries(refs[bucket].map((ref, index) => ({
      version: LOOM_POLICY_VERSION,
      id: `${bucket}-${ref.promptOrder}-${ref.blockId}`,
      source: loomSourceForRef(ref, source, `policies.${bucket}[${index}]`),
      destination: LOOM_BUCKET_DESTINATION[bucket],
      checkpoint: LOOM_BUCKET_CHECKPOINT[bucket],
      required: true,
      visibility: "work_only",
    } satisfies LoomPolicyEntryV1))),
  ])) as Record<LoomPolicyBucketV1, LoomPolicyEntryV1[]>;
  return { version: LOOM_POLICY_VERSION, workPolicy: buckets.workPolicy, workspaceUsage: buckets.workspaceUsage, completionCriteria: buckets.completionCriteria, renderPolicy: buckets.renderPolicy };
}

function validateLoomPolicySources(policies: LoomPolicyBucketsV1, source: CognitionSourceSnapshotV1): void {
  const sourceByPromptOrder = new Map(source.blocks.map((block) => [block.promptOrder, block] as const));
  for (const bucket of LOOM_POLICY_BUCKETS) {
    for (const [index, entry] of policies[bucket].entries()) {
      const block = sourceByPromptOrder.get(entry.source.promptOrder);
      if (!block || block.blockId !== entry.source.blockId) {
        if (entry.required) fail("missing_reference", `policies.${bucket}[${index}].source.blockId`, "Loom block occurrence is missing from the source snapshot");
        continue;
      }
      if (entry.source.presetRevision !== source.presetRevision || entry.source.blockRevision !== block.revision) {
        if (entry.required) fail("revision_mismatch", `policies.${bucket}[${index}].source`, "source revision does not match the frozen source");
        continue;
      }
    }
  }
}

export function normalizeLoomPolicyBucketsV1(value: unknown, sourceValue: unknown): LoomPolicyBucketsV1 {
  const source = parseCognitionSourceSnapshot(sourceValue);
  const parsed = value === undefined || value === null
    ? policyEntriesFromRefs({ workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] }, source)
    : isPlainRecord(value) && value.version === LOOM_POLICY_VERSION ? parseLoomPolicyBuckets(value) : policyEntriesFromRefs(parseCognitionPolicyRefs(value), source);
  validateLoomPolicySources(parsed, source);
  return deepFreeze(parsed);
}
export const normalizeLoomPolicyBuckets = normalizeLoomPolicyBucketsV1;

function parseDependencies(value: unknown, path: string, budget: ParseBudget): string[] {
  if (value === undefined) return [];
  const values = ensureArray(value, path);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const dependency = ensureId(values[index], `${path}[${index}]`);
    accountListBytes(budget, dependency, `${path}[${index}]`);
    if (seen.has(dependency)) fail("duplicate_id", `${path}[${index}]`, "duplicate dependency");
    seen.add(dependency);
    result.push(dependency);
  }
  result.sort(compareUtf8);
  return result;
}

function parseOptionalPredicate(value: PlainRecord, path: string, budget: ParseBudget): CognitionPredicateV1 | undefined {
  return has(value, "activation") ? parsePredicate(value.activation, `${path}.activation`, budget, 1) : undefined;
}

function parseTask(value: unknown, path: string, budget: ParseBudget): TaskTemplateV1 {
  const object = record(value, path);
  exactKeys(object, ["id", "required", "dependencies", "activation", "label", "description"], path);
  const result: TaskTemplateV1 = { id: ensureId(object.id, `${path}.id`), required: ensureBoolean(object.required, `${path}.required`), dependencies: parseDependencies(object.dependencies, `${path}.dependencies`, budget) };
  const activation = parseOptionalPredicate(object, path, budget);
  if (activation !== undefined) (result as { activation: CognitionPredicateV1 }).activation = activation;
  if (has(object, "label")) (result as { label: string }).label = ensureSafeText(object.label, `${path}.label`);
  if (has(object, "description")) (result as { description: string }).description = ensureSafeText(object.description, `${path}.description`);
  return result;
}

/** Standalone strict parser for editor/import validation. */
export function parseTaskTemplate(value: unknown): TaskTemplateV1 {
  return parseTask(value, "template", { predicateNodes: 0, listBytes: 0 });
}

/** Parse the complete authored task-and-Loom graph with one shared cap budget. */
export function parseCognitionGraph(value: unknown): CognitionGraphV1 {
  const object = record(value, "graph");
  exactKeys(object, ["version", "policies", "templates"], "graph");
  if (object.version !== AGENT_COGNITION_VERSION) fail("invalid_value", "graph.version", "unsupported cognition version");
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const templatesRaw = ensureArray(object.templates, "graph.templates", COGNITION_MAX_TASK_TEMPLATES);
  const templates = templatesRaw.map((item, index) => parseTask(item, `graph.templates[${index}]`, budget));
  assertUniqueIds(templates.map((item) => item.id), "graph.templates");
  templates.sort((left, right) => compareUtf8(left.id, right.id));
  return { version: AGENT_COGNITION_VERSION, policies: parsePolicyRefsWithBudget(object.policies, budget), templates };
}

function assertUniqueIds(ids: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail("duplicate_id", path, `duplicate id ${id}`);
    seen.add(id);
  }
}

/** Parse a source snapshot supplied by the host before isolate execution. */
export function parseCognitionSourceSnapshot(value: unknown): CognitionSourceSnapshotV1 {
  const object = record(value, "source");
  exactKeys(object, ["presetRevision", "blocks"], "source");
  const blocksRaw = ensureArray(object.blocks, "source.blocks", COGNITION_MAX_SOURCE_BLOCKS);
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const blocks: CognitionSourceBlockV1[] = blocksRaw.map((item, index) => {
    const block = record(item, `source.blocks[${index}]`);
    exactKeys(block, ["blockId", "revision", "promptOrder"], `source.blocks[${index}]`);
    const blockId = ensureId(block.blockId, `source.blocks[${index}].blockId`);
    accountListBytes(budget, blockId, `source.blocks[${index}].blockId`);
    return { blockId, revision: ensureRevision(block.revision, `source.blocks[${index}].revision`), promptOrder: ensureRevision(block.promptOrder, `source.blocks[${index}].promptOrder`) };
  });
  const promptOrders = new Set<number>();
  for (const [index, block] of blocks.entries()) {
    if (promptOrders.has(block.promptOrder)) fail("duplicate_id", `source.blocks[${index}].promptOrder`, "duplicate prompt-order occurrence");
    promptOrders.add(block.promptOrder);
  }
  blocks.sort((left, right) => compareNumber(left.promptOrder, right.promptOrder) || compareUtf8(left.blockId, right.blockId));
  return { presetRevision: ensureRevision(object.presetRevision, "source.presetRevision"), blocks };
}

function parseEvaluationRecord(value: unknown, path: string, budget: ParseBudget): Record<string, CognitionValue> {
  const object = record(value, path);
  const result: Record<string, CognitionValue> = Object.create(null);
  const keys = Object.keys(object).sort(compareUtf8);
  for (const key of keys) {
    const id = ensureId(key, `${path}.${key}`);
    accountListBytes(budget, id, `${path}.${key}`);
    result[id] = parseValue(object[key], `${path}.${key}`, budget);
  }
  return result;
}

/** Parse/freeze the serializable snapshot consumed by predicate evaluation. */
export function parseCognitionEvaluationContext(value: unknown): CognitionEvaluationContextV1 {
  const object = record(value, "context");
  exactKeys(object, ["generationType", "phase", "presetVariables", "participantFacts", "availableTools", "taskTransitions"], "context");
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const toolsRaw = ensureArray(object.availableTools, "context.availableTools");
  const tools: string[] = [];
  const seenTools = new Set<string>();
  for (let index = 0; index < toolsRaw.length; index += 1) {
    const tool = ensureId(toolsRaw[index], `context.availableTools[${index}]`);
    accountListBytes(budget, tool, `context.availableTools[${index}]`);
    if (seenTools.has(tool)) fail("duplicate_id", `context.availableTools[${index}]`, "duplicate tool id");
    seenTools.add(tool);
    tools.push(tool);
  }
  tools.sort(compareUtf8);
  const transitionsObject = record(object.taskTransitions, "context.taskTransitions");
  const transitionKeys = Object.keys(transitionsObject).sort(compareUtf8);
  if (transitionKeys.length > COGNITION_MAX_LIST_ITEMS) fail("limit_exceeded", "context.taskTransitions", `must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);
  const taskTransitions: Record<string, CognitionTaskTransition> = Object.create(null);
  for (const key of transitionKeys) {
    const taskId = ensureId(key, `context.taskTransitions.${key}`);
    accountListBytes(budget, taskId, `context.taskTransitions.${key}`);
    taskTransitions[taskId] = ensureEnum(transitionsObject[key], TASK_TRANSITIONS, `context.taskTransitions.${key}`);
  }
  return deepFreeze({
    generationType: ensureEnum(object.generationType, GENERATION_TYPES, "context.generationType"),
    phase: ensureEnum(object.phase, PHASES, "context.phase"),
    presetVariables: parseEvaluationRecord(object.presetVariables, "context.presetVariables", budget),
    participantFacts: parseEvaluationRecord(object.participantFacts, "context.participantFacts", budget),
    availableTools: tools,
    taskTransitions,
  });
}

function dependencyClosure(ids: readonly string[], dependencies: ReadonlyMap<string, readonly string[]>, path: string): Readonly<Record<string, readonly string[]>> {
  const known = new Set(ids);
  const state = new Map<string, 0 | 1 | 2>();
  const closure = new Map<string, string[]>();
  const visit = (id: string): string[] => {
    const current = state.get(id);
    if (current === 1) fail("cycle", `${path}.${id}`, "dependency cycle");
    if (current === 2) return closure.get(id) ?? [];
    if (!known.has(id)) fail("missing_reference", `${path}.${id}`, "dependency references a missing node");
    state.set(id, 1);
    const values = new Set<string>();
    for (const dependency of dependencies.get(id) ?? []) {
      if (!known.has(dependency)) fail("missing_reference", `${path}.${id}`, `missing dependency ${dependency}`);
      values.add(dependency);
      for (const nested of visit(dependency)) values.add(nested);
    }
    const sorted = [...values].sort(compareUtf8);
    state.set(id, 2);
    closure.set(id, sorted);
    return sorted;
  };
  for (const id of ids) visit(id);
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const id of [...ids].sort(compareUtf8)) result[id] = closure.get(id) ?? [];
  return result;
}

function normalizePolicyRefs(policies: CognitionPolicyRefsV1, source: CognitionSourceSnapshotV1): { policies: CognitionPolicyRefsV1; blockRevisions: CognitionFrozenSourceRevisionsV1["blockRevisions"] } {
  const sourceByPromptOrder = new Map(source.blocks.map((block) => [block.promptOrder, block] as const));
  const selected = new Map<number, CognitionSourceBlockV1>();
  const normalize = (refs: readonly CognitionLoomBlockRefV1[], path: string): CognitionLoomBlockRefV1[] => {
    const result: CognitionLoomBlockRefV1[] = [];
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const block = sourceByPromptOrder.get(ref.promptOrder);
      if (!block || block.blockId !== ref.blockId) fail("missing_reference", `${path}[${index}].blockId`, "Loom block occurrence is missing from the source snapshot");
      if (ref.expectedPresetRevision !== source.presetRevision) fail("revision_mismatch", `${path}[${index}].expectedPresetRevision`, "preset revision does not match the frozen source");
      if (ref.expectedBlockRevision !== block.revision) fail("revision_mismatch", `${path}[${index}].expectedBlockRevision`, "block revision does not match the frozen source");
      selected.set(ref.promptOrder, block);
      result.push(ref);
    }
    return result.sort((left, right) => compareNumber(left.promptOrder, right.promptOrder) || compareUtf8(left.blockId, right.blockId));
  };
  const normalized = {
    workPolicy: normalize(policies.workPolicy, "policies.workPolicy"),
    workspaceUsage: normalize(policies.workspaceUsage, "policies.workspaceUsage"),
    completionCriteria: normalize(policies.completionCriteria, "policies.completionCriteria"),
    renderPolicy: normalize(policies.renderPolicy, "policies.renderPolicy"),
  } satisfies CognitionPolicyRefsV1;
  const blockRevisions = [...selected.values()].map((block) => ({ blockId: block.blockId, revision: block.revision, promptOrder: block.promptOrder }))
    .sort((left, right) => compareNumber(left.promptOrder, right.promptOrder) || compareUtf8(left.blockId, right.blockId));
  return { policies: normalized, blockRevisions };
}

/** Validate dependencies and expected source revisions, then deep-freeze the graph. */
export function freezeCognitionGraph(graphValue: unknown, sourceValue: unknown): FrozenCognitionGraphV1 {
  const graph = parseCognitionGraph(graphValue);
  const source = parseCognitionSourceSnapshot(sourceValue);
  const templateIds = graph.templates.map((template) => template.id);
  const templateDependencies = new Map(graph.templates.map((template) => [template.id, template.dependencies ?? []] as const));
  const templateDependencyClosure = dependencyClosure(templateIds, templateDependencies, "graph.templates");
  const requiredTemplateIds = graph.templates.filter((template) => template.required).map((template) => template.id);
  const requiredTemplateSet = new Set<string>();
  for (const id of requiredTemplateIds) {
    requiredTemplateSet.add(id);
    for (const dependency of templateDependencyClosure[id] ?? []) requiredTemplateSet.add(dependency);
  }
  const normalized = normalizePolicyRefs(graph.policies, source);
  return deepFreeze({
    version: AGENT_COGNITION_VERSION,
    policies: normalized.policies,
    templates: graph.templates,
    sourceRevisions: { presetRevision: source.presetRevision, blockRevisions: normalized.blockRevisions },
    templateDependencyClosure,
    requiredTemplateClosure: [...requiredTemplateSet].sort(compareUtf8),
  });
}
export const freezeCognitionGraphV1 = freezeCognitionGraph;

export interface AgentCognitionLoaderV1 {
  readonly config: unknown;
  readonly taskTemplates: readonly unknown[];
}
export interface FrozenAgentCognitionV1 {
  readonly graph: FrozenCognitionGraphV1;
  readonly source: CognitionSourceSnapshotV1;
  readonly policyBuckets: LoomPolicyBucketsV1;
}

const EMPTY_COGNITION_POLICY: CognitionPolicyRefsV1 = Object.freeze({ workPolicy: Object.freeze([]), workspaceUsage: Object.freeze([]), completionCriteria: Object.freeze([]), renderPolicy: Object.freeze([]) });

function refsFromLoomPolicyBuckets(policies: LoomPolicyBucketsV1, source: CognitionSourceSnapshotV1): CognitionPolicyRefsV1 {
  const sourceByPromptOrder = new Map(source.blocks.map((block) => [block.promptOrder, block] as const));
  const refs = Object.fromEntries(LOOM_POLICY_BUCKETS.map((bucket) => [
    bucket,
    policies[bucket].filter((entry) => {
      const block = sourceByPromptOrder.get(entry.source.promptOrder);
      return block !== undefined && block.blockId === entry.source.blockId && entry.source.presetRevision === source.presetRevision && entry.source.blockRevision === block.revision;
    }).map((entry) => ({ blockId: entry.source.blockId, expectedPresetRevision: entry.source.presetRevision, expectedBlockRevision: entry.source.blockRevision, promptOrder: entry.source.promptOrder })),
  ])) as Record<LoomPolicyBucketV1, CognitionLoomBlockRefV1[]>;
  return { workPolicy: refs.workPolicy, workspaceUsage: refs.workspaceUsage, completionCriteria: refs.completionCriteria, renderPolicy: refs.renderPolicy };
}

export function freezeAgentCognitionV1(loader: AgentCognitionLoaderV1, sourceValue: unknown): FrozenAgentCognitionV1 | null {
  if (!loader || typeof loader !== "object" || Array.isArray(loader)) fail("invalid_type", "loader", "must be an object");
  if (!Array.isArray(loader.taskTemplates)) fail("invalid_type", "loader.taskTemplates", "must be an array");
  const source = parseCognitionSourceSnapshot(sourceValue);
  const config = loader.config === null || loader.config === undefined ? {} : record(loader.config, "loader.config");
  const runtimePolicy = has(config, "runtimePolicy") ? parseCanonicalRuntimePolicyV1(config.runtimePolicy, "loader.config.runtimePolicy") : null;
  const authoredLoomPolicy = runtimePolicy?.loomPolicy ?? null;
  const policyBuckets = normalizeLoomPolicyBucketsV1(authoredLoomPolicy ?? EMPTY_COGNITION_POLICY, source);
  const cognitionPolicy = refsFromLoomPolicyBuckets(policyBuckets, source);
  const hasCognitionPolicy = LOOM_POLICY_BUCKETS.some((bucket) => policyBuckets[bucket].length > 0);
  const hasCustomPhasePolicy = (runtimePolicy?.phases.length ?? 0) > 0;
  const hasPolicy = hasCognitionPolicy || hasCustomPhasePolicy || loader.taskTemplates.length > 0;
  if (!hasPolicy) return null;
  const graph = freezeCognitionGraph({ version: AGENT_COGNITION_VERSION, policies: cognitionPolicy, templates: loader.taskTemplates }, source);
  return Object.freeze({ graph, source, policyBuckets });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function activateIds(existing: readonly string[], direct: readonly string[], closure: Readonly<Record<string, readonly string[]>>): string[] {
  const result = new Set(existing);
  for (const id of direct) {
    result.add(id);
    for (const dependency of closure[id] ?? []) result.add(dependency);
  }
  return [...result].sort(compareUtf8);
}

function parseActivationState(value: CognitionActivationStateV1, graph: FrozenCognitionGraphV1): CognitionActivationStateV1 {
  const object = record(value, "state");
  exactKeys(object, ["version", "workspaceRevision", "activatedTemplateIds", "requiredTemplateIds"], "state");
  if (object.version !== AGENT_COGNITION_VERSION) fail("invalid_state", "state.version", "unsupported cognition version");
  const workspaceRevision = ensureRevision(object.workspaceRevision, "state.workspaceRevision");
  const known = new Set(graph.templates.map((template) => template.id));
  const parseIds = (raw: unknown, path: string): string[] => {
    const values = ensureArray(raw, path, COGNITION_MAX_TASK_TEMPLATES);
    const result: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < values.length; index += 1) {
      const id = ensureId(values[index], `${path}[${index}]`);
      if (seen.has(id)) fail("invalid_state", `${path}[${index}]`, "duplicate id");
      if (!known.has(id)) fail("invalid_state", `${path}[${index}]`, "unknown graph id");
      seen.add(id);
      result.push(id);
    }
    result.sort(compareUtf8);
    return result;
  };
  const activatedTemplateIds = parseIds(object.activatedTemplateIds, "state.activatedTemplateIds");
  const requiredTemplateIds = parseIds(object.requiredTemplateIds, "state.requiredTemplateIds");
  for (const id of requiredTemplateIds) if (!activatedTemplateIds.includes(id)) fail("invalid_state", "state.requiredTemplateIds", "required task is not activated");
  const activatedSet = new Set(activatedTemplateIds);
  for (const id of activatedTemplateIds) for (const dependency of graph.templateDependencyClosure[id] ?? []) if (!activatedSet.has(dependency)) fail("invalid_state", "state.activatedTemplateIds", "activated task is missing a dependency");
  const requiredSet = new Set(requiredTemplateIds);
  for (const id of requiredTemplateIds) for (const dependency of graph.templateDependencyClosure[id] ?? []) if (!requiredSet.has(dependency)) fail("invalid_state", "state.requiredTemplateIds", "required task is missing a dependency");
  const inducedRequired = activateIds([], graph.templates.filter((template) => template.required && activatedSet.has(template.id)).map((template) => template.id), graph.templateDependencyClosure);
  if (inducedRequired.length !== requiredTemplateIds.length || inducedRequired.some((id, index) => id !== requiredTemplateIds[index])) fail("required_closure_invalid", "state.requiredTemplateIds", "required tasks do not match activated authored required closure");
  return deepFreeze({ version: AGENT_COGNITION_VERSION, workspaceRevision, activatedTemplateIds, requiredTemplateIds });
}

function evaluationContext(value: CognitionEvaluationContextV1): CognitionEvaluationContextV1 {
  return parseCognitionEvaluationContext(value);
}

function evaluateVariablePredicate(predicate: Extract<CognitionPredicateV1, { kind: "preset_variable" | "participant_fact" }>, values: Readonly<Record<string, CognitionValue>>): boolean {
  const present = OBJECT_PROTO.hasOwnProperty.call(values, predicate.name);
  if (predicate.operator === "present") return present;
  if (!present) return false;
  const actual = values[predicate.name];
  if (predicate.operator === "equals") return valueEqual(actual, predicate.value);
  if (predicate.operator === "in") return isCognitionScalar(actual) ? predicate.values.some((expected) => scalarEqual(actual, expected)) : actual.some((item) => predicate.values.some((expected) => scalarEqual(item, expected)));
  return !isCognitionScalar(actual) && actual.some((item) => scalarEqual(item, predicate.value));
}

/** Pure, closed AST evaluator. */
export function evaluateCognitionPredicate(predicateValue: unknown, contextValue: CognitionEvaluationContextV1): boolean {
  const predicate = parseCognitionPredicate(predicateValue);
  const context = evaluationContext(contextValue);
  const evaluate = (node: CognitionPredicateV1): boolean => {
    switch (node.kind) {
      case "all": return node.children.every(evaluate);
      case "any": return node.children.some(evaluate);
      case "not": return !evaluate(node.child);
      case "generation_type": return context.generationType === node.value;
      case "phase": return context.phase === node.value;
      case "preset_variable": return evaluateVariablePredicate(node, context.presetVariables);
      case "participant_fact": return evaluateVariablePredicate(node, context.participantFacts);
      case "tool_available": return context.availableTools.includes(node.toolId) === node.available;
      case "task_transition": return context.taskTransitions[node.taskId] === node.transition;
    }
  };
  return evaluate(predicate);
}
export const evaluateCognitionPredicateV1 = evaluateCognitionPredicate;

function createEmptyActivationState(): CognitionActivationStateV1 {
  return { version: AGENT_COGNITION_VERSION, workspaceRevision: 0, activatedTemplateIds: [], requiredTemplateIds: [] };
}

/** Create an empty append-only state for the frozen graph. */
export function createCognitionActivationState(graph: FrozenCognitionGraphV1, workspaceRevision = 0): CognitionActivationStateV1 {
  return parseActivationState({ ...createEmptyActivationState(), workspaceRevision }, graph);
}

function difference(after: readonly string[], before: readonly string[]): string[] {
  const previous = new Set(before);
  return after.filter((id) => !previous.has(id));
}

function activateAtPointInternal(graph: FrozenCognitionGraphV1, stateValue: CognitionActivationStateV1, contextValue: CognitionEvaluationContextV1, point: CognitionActivationPointV1, roots?: CognitionActivationRootsV1): CognitionActivationResultV1 {
  const state = parseActivationState(stateValue, graph);
  const context = evaluationContext(contextValue);
  const rootSet = roots === undefined ? undefined : new Set(roots.templateIds);
  const directTemplates = graph.templates
    .filter((template) => !state.activatedTemplateIds.includes(template.id))
    .filter((template) => rootSet === undefined || rootSet.has(template.id))
    .filter((template) => template.activation === undefined || evaluateCognitionPredicate(template.activation, context))
    .map((template) => template.id)
    .sort(compareUtf8);
  const activatedTemplateIds = activateIds(state.activatedTemplateIds, directTemplates, graph.templateDependencyClosure);
  const requiredTemplateRoots = graph.templates.filter((template) => template.required && activatedTemplateIds.includes(template.id)).map((template) => template.id);
  const requiredTemplateIds = activateIds([], requiredTemplateRoots, graph.templateDependencyClosure);
  const nextState = deepFreeze({ version: AGENT_COGNITION_VERSION, workspaceRevision: state.workspaceRevision, activatedTemplateIds, requiredTemplateIds });
  return { point, state: nextState, newlyActivatedTemplateIds: difference(activatedTemplateIds, state.activatedTemplateIds), newlyRequiredTemplateIds: difference(requiredTemplateIds, state.requiredTemplateIds) };
}

/** Evaluate append-only activation at initial creation, phase entry, or a task transition. */
export function activateCognitionAtPoint(graph: FrozenCognitionGraphV1, state: CognitionActivationStateV1, context: CognitionEvaluationContextV1, point: CognitionActivationPointV1, roots?: CognitionActivationRootsV1): CognitionActivationResultV1 {
  return activateAtPointInternal(graph, state, context, point, roots);
}
export const activateCognition = activateCognitionAtPoint;

/** Run the bounded completion activation fixed point. */
export function completeCognitionFixedPoint(graph: FrozenCognitionGraphV1, state: CognitionActivationStateV1, context: CognitionEvaluationContextV1, roots?: CognitionActivationRootsV1): CognitionCompletionResultV1 {
  let current = activateAtPointInternal(graph, state, context, "completion_fixed_point", roots);
  let iterations = 1;
  const maxIterations = Math.max(1, graph.templates.length + 1);
  while (current.newlyActivatedTemplateIds.length > 0) {
    if (iterations >= maxIterations) fail("fixed_point_limit_exceeded", "completion", "activation did not reach a bounded fixed point");
    iterations += 1;
    current = activateAtPointInternal(graph, current.state, context, "completion_fixed_point", roots);
  }
  const blockingRequiredTaskIds = current.state.requiredTemplateIds.filter((taskId) => context.taskTransitions[taskId] !== "completed").sort(compareUtf8);
  return { ...current, newlyActivatedTemplateIds: difference(current.state.activatedTemplateIds, state.activatedTemplateIds), newlyRequiredTemplateIds: difference(current.state.requiredTemplateIds, state.requiredTemplateIds), fixedPointIterations: iterations, blockingRequiredTaskIds, canComplete: blockingRequiredTaskIds.length === 0 };
}
export const runCognitionCompletionFixedPoint = completeCognitionFixedPoint;

/** Apply a named workspace task transition and cognition activation in one CAS. */
export function applyCognitionTaskTransitionInCas(graph: FrozenCognitionGraphV1, state: CognitionActivationStateV1, context: CognitionEvaluationContextV1, taskIdValue: string, transitionValue: CognitionTaskTransition, cas: CognitionWorkspaceCasV1): CognitionTaskTransitionResultV1 {
  const taskId = ensureId(taskIdValue, "taskId");
  const transition = ensureEnum(transitionValue, TASK_TRANSITIONS, "transition");
  const initialState = parseActivationState(state, graph);
  const parsedContext = parseCognitionEvaluationContext(context);
  let activation: CognitionActivationResultV1 | undefined;
  const committed = cas.commit(initialState.workspaceRevision, (current) => {
    const currentState = parseActivationState(current, graph);
    const nextTransitions: Record<string, CognitionTaskTransition> = { ...parsedContext.taskTransitions, [taskId]: transition };
    activation = activateAtPointInternal(graph, currentState, { ...parsedContext, taskTransitions: nextTransitions }, "task_transition");
    return { ...activation.state, workspaceRevision: currentState.workspaceRevision + 1 };
  });
  if (!activation) fail("cas_conflict", "cas", "workspace CAS did not invoke its updater");
  const committedState = parseActivationState(committed, graph);
  return { taskId, transition, state: committedState, activation: { ...activation, state: committedState } };
}
export const transitionTaskWithCognition = applyCognitionTaskTransitionInCas;

function loomSourcePin(source: LoomPolicySourceV1): string {
  return `${source.presetRevision}\u0000${source.blockRevision}\u0000${source.promptOrder}`;
}

function loomDestBlockKey(destination: LoomPolicyDestinationV1, source: LoomPolicySourceV1): string {
  return `${destination}:${loomOccurrenceKey(source.blockId, source.promptOrder)}`;
}

function conflictingDestBlockEntryIds(policies: LoomPolicyBucketsV1): ReadonlySet<string> {
  const groups = new Map<string, { pin: string; ids: string[]; conflicted: boolean }>();
  const conflicting = new Set<string>();
  for (const bucket of LOOM_POLICY_BUCKETS) {
    for (const entry of policies[bucket]) {
      const key = loomDestBlockKey(entry.destination, entry.source);
      const pin = loomSourcePin(entry.source);
      const group = groups.get(key);
      if (!group) {
        groups.set(key, { pin, ids: [entry.id], conflicted: false });
        continue;
      }
      group.ids.push(entry.id);
      if (group.pin !== pin) group.conflicted = true;
      if (group.conflicted) {
        for (const id of group.ids) conflicting.add(id);
      }
    }
  }
  return conflicting;
}

function loomPolicySourceKey(source: LoomPolicySourceV1): string {
  return `${source.blockId}\u0000${source.presetRevision}\u0000${source.blockRevision}\u0000${source.promptOrder}`;
}

function loomPromptInspectionItem(entry: LoomPolicyEntryV1, bucket: LoomPolicyBucketV1, outcome: LoomPromptInspectionOutcomeV1, effectiveText: string | null, conditionResult?: LoomPolicyConditionResultV1): LoomPromptInspectionItemV1 {
  return {
    entryId: entry.id,
    bucket,
    destination: entry.destination,
    checkpoint: entry.checkpoint,
    source: entry.source,
    ...(entry.condition === undefined ? {} : { condition: entry.condition }),
    ...(conditionResult === undefined ? {} : { conditionResult }),
    effectiveText,
    required: entry.required,
    ordinaryPromptSuppressed: true,
    outcome,
  };
}

function parseLoomPromptInspectionOutcome(value: unknown, path: string): LoomPromptInspectionOutcomeV1 {
  const object = record(value, path);
  const status = ensureEnum(object.status, ["included", "skipped", "rejected", "omitted", "deduplicated"] as const, `${path}.status`);
  if (status === "included") {
    exactKeys(object, ["status", "effectiveIndex", "reason"], path);
    if (object.reason !== "selected") fail("invalid_value", `${path}.reason`, "included items must record selected");
    return { status, effectiveIndex: ensureRevision(object.effectiveIndex, `${path}.effectiveIndex`), reason: "selected" };
  }
  if (status === "skipped") {
    exactKeys(object, ["status", "reason"], path);
    return { status, reason: ensureEnum(object.reason, ["checkpoint_not_reached", "condition_not_met", "stale_source"] as const, `${path}.reason`) };
  }
  if (status === "rejected") {
    exactKeys(object, ["status", "reason"], path);
    return { status, reason: ensureEnum(object.reason, ["invalid_source", "stale_source", "required_source_unavailable"] as const, `${path}.reason`) };
  }
  if (status === "omitted") {
    exactKeys(object, ["status", "reason"], path);
    return { status, reason: ensureEnum(object.reason, ["response_mode", "destination_unavailable", "not_work_surface"] as const, `${path}.reason`) };
  }
  exactKeys(object, ["status", "reason", "keptEntryId", "destination"], path);
  if (object.reason !== "destination_overlap") fail("invalid_value", `${path}.reason`, "deduplicated items must record destination_overlap");
  return {
    status,
    reason: "destination_overlap",
    keptEntryId: ensureId(object.keptEntryId, `${path}.keptEntryId`),
    destination: ensureEnum(object.destination, LOOM_POLICY_DESTINATIONS, `${path}.destination`),
  };
}

function parseLoomResponsePolicyOmission(value: unknown, path: string): LoomResponsePolicyOmissionV1 {
  const object = record(value, path);
  exactKeys(object, ["version", "surface", "visibility", "reason", "omittedEntryIds", "source", "omittedPhaseInstructions", "reviewReason"], path);
  const reviewReason = object.reviewReason === undefined ? undefined : ensureId(object.reviewReason, path + ".reviewReason");
  if (object.version !== LOOM_POLICY_VERSION) fail("invalid_value", path + ".version", "unsupported Loom policy version");
  if (object.visibility !== "work_only") fail("invalid_value", path + ".visibility", "must be work_only");
  if (object.surface !== "RESPONSE") fail("invalid_value", path + ".surface", "must be RESPONSE");
  const omittedEntryIds = ensureArray(object.omittedEntryIds, path + ".omittedEntryIds", COGNITION_MAX_BLOCK_REFS_TOTAL).map((entryId, index) => ensureId(entryId, path + ".omittedEntryIds[" + index + "]"));
  assertUniqueIds(omittedEntryIds, path + ".omittedEntryIds");
  const source = ensureArray(object.source, path + ".source", COGNITION_MAX_BLOCK_REFS_TOTAL).map((entrySource, index) => parseLoomPolicySource(entrySource, path + ".source[" + index + "]"));
  if (source.length !== omittedEntryIds.length) fail("invalid_value", path, "omitted entry IDs and sources must have equal length");
  const omittedPhaseInstructions = ensureArray(object.omittedPhaseInstructions, path + ".omittedPhaseInstructions", COGNITION_MAX_SOURCE_BLOCKS).map((instruction, index) => {
    const instructionPath = path + ".omittedPhaseInstructions[" + index + "]";
    const instructionObject = record(instruction, instructionPath);
    exactKeys(instructionObject, ["phaseId", "source", "profileId"], instructionPath);
    return {
      phaseId: ensureId(instructionObject.phaseId, instructionPath + ".phaseId"),
      source: parseLoomPolicySource(instructionObject.source, instructionPath + ".source"),
      ...(instructionObject.profileId === undefined ? {} : { profileId: ensureId(instructionObject.profileId, instructionPath + ".profileId") }),
    };
  });
  return deepFreeze({ version: LOOM_POLICY_VERSION, surface: "RESPONSE", visibility: "work_only", reason: "work_only", ...(reviewReason === undefined ? {} : { reviewReason }), omittedEntryIds, source, omittedPhaseInstructions });
}

export function parseLoomPromptInspectionV1(value: unknown, path = "inspection"): LoomPromptInspectionV1 {
  const object = record(value, path);
  exactKeys(object, ["version", "surface", "checkpoint", "items", "effectiveEntryIds", "responseOmission"], path);
  if (object.version !== LOOM_POLICY_VERSION) fail("invalid_value", `${path}.version`, "unsupported Loom policy version");
  const surface = ensureEnum(object.surface, ["WORK", "RESPONSE"] as const, `${path}.surface`);
  const checkpoint = ensureEnum(object.checkpoint, LOOM_POLICY_CHECKPOINTS, `${path}.checkpoint`);
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const items = ensureArray(object.items, `${path}.items`, COGNITION_MAX_BLOCK_REFS_TOTAL).map((item, index): LoomPromptInspectionItemV1 => {
    const itemPath = `${path}.items[${index}]`;
    const itemObject = record(item, itemPath);
    exactKeys(itemObject, ["entryId", "bucket", "destination", "checkpoint", "source", "condition", "conditionResult", "effectiveText", "required", "ordinaryPromptSuppressed", "outcome"], itemPath);
    const effectiveText = itemObject.effectiveText === null ? null : ensureSafeText(itemObject.effectiveText, `${itemPath}.effectiveText`);
    const condition = itemObject.condition === undefined ? undefined : parsePredicate(itemObject.condition, `${itemPath}.condition`, budget, 1);
    const conditionResult = itemObject.conditionResult === undefined ? undefined : ensureEnum(itemObject.conditionResult, ["true", "false", "not_evaluated", "invalid", "not_applicable"] as const, `${itemPath}.conditionResult`);
    if (condition === undefined && conditionResult !== undefined && conditionResult !== "not_applicable") fail("invalid_value", `${itemPath}.conditionResult`, "an unconditional Loom entry must be not_applicable");
    if (condition !== undefined && conditionResult === undefined) fail("invalid_value", `${itemPath}.conditionResult`, "a conditional Loom entry requires an evaluation result");
    const required = ensureBoolean(itemObject.required, `${itemPath}.required`);
    const ordinaryPromptSuppressed = ensureBoolean(itemObject.ordinaryPromptSuppressed, `${itemPath}.ordinaryPromptSuppressed`);
    const bucket = ensureEnum(itemObject.bucket, LOOM_POLICY_BUCKETS, `${itemPath}.bucket`);
    const destination = ensureEnum(itemObject.destination, LOOM_POLICY_DESTINATIONS, `${itemPath}.destination`);
    const checkpoint = ensureEnum(itemObject.checkpoint, LOOM_POLICY_CHECKPOINTS, `${itemPath}.checkpoint`);
    if (destination !== LOOM_BUCKET_DESTINATION[bucket]) fail("invalid_value", `${itemPath}.destination`, "destination does not match the Loom bucket");
    if (checkpoint !== LOOM_BUCKET_CHECKPOINT[bucket]) fail("invalid_value", `${itemPath}.checkpoint`, "checkpoint does not match the Loom bucket");
    return {
      entryId: ensureId(itemObject.entryId, `${itemPath}.entryId`),
      bucket,
      destination,
      checkpoint,
      source: parseLoomPolicySource(itemObject.source, `${itemPath}.source`),
      ...(condition === undefined ? {} : { condition }),
      ...(conditionResult === undefined ? {} : { conditionResult }),
      effectiveText,
      required,
      ordinaryPromptSuppressed,
      outcome: parseLoomPromptInspectionOutcome(itemObject.outcome, `${itemPath}.outcome`),
    };
  });
  const itemIds = items.map((item) => item.entryId);
  assertUniqueIds(itemIds, `${path}.items`);
  const effectiveEntryIds = ensureArray(object.effectiveEntryIds, `${path}.effectiveEntryIds`, COGNITION_MAX_BLOCK_REFS_TOTAL).map((entryId, index) => ensureId(entryId, `${path}.effectiveEntryIds[${index}]`));
  assertUniqueIds(effectiveEntryIds, `${path}.effectiveEntryIds`);
  const includedItems = items.filter((item) => item.outcome.status === "included");
  if (includedItems.length !== effectiveEntryIds.length) fail("invalid_value", `${path}.effectiveEntryIds`, "must match included inspection items");
  for (const item of includedItems) {
    const effectiveIndex = item.outcome.status === "included" ? item.outcome.effectiveIndex : -1;
    if (effectiveEntryIds[effectiveIndex] !== item.entryId) fail("invalid_value", `${path}.effectiveEntryIds`, "included item index does not match its entry ID");
  }
  const responseOmission = object.responseOmission === undefined ? undefined : parseLoomResponsePolicyOmission(object.responseOmission, `${path}.responseOmission`);
  if (surface === "WORK" && responseOmission !== undefined) fail("invalid_value", `${path}.responseOmission`, "WORK inspection cannot carry a Response omission");
  if (surface === "RESPONSE") {
    if (!responseOmission) fail("invalid_value", `${path}.responseOmission`, "Response inspection requires omission evidence");
    if (responseOmission.omittedEntryIds.length !== itemIds.length || responseOmission.omittedEntryIds.some((entryId, index) => entryId !== itemIds[index]) || items.some((item) => item.outcome.status !== "omitted")) fail("invalid_value", `${path}.responseOmission`, "Response omission evidence does not match inspection items");
  }
  return deepFreeze({ version: LOOM_POLICY_VERSION, surface, checkpoint, items, effectiveEntryIds, ...(responseOmission === undefined ? {} : { responseOmission }) });
}

function previousLoomInspection(
  input: LoomPromptInspectionInputV1,
  surface: "WORK" | "RESPONSE",
  checkpoint: LoomPolicyCheckpointV1,
  flattened: readonly { readonly bucket: LoomPolicyBucketV1; readonly entry: LoomPolicyEntryV1 }[],
): LoomPromptInspectionV1 | undefined {
  if (input.previousInspection === undefined) return undefined;
  const previous = parseLoomPromptInspectionV1(input.previousInspection, "inspection.previousInspection");
  if (surface !== "WORK" || previous.surface !== "WORK") {
    fail("invalid_value", "inspection.previousInspection.surface", "only WORK inspection evidence can advance checkpoints");
  }
  if (LOOM_CHECKPOINT_RANK[previous.checkpoint] >= LOOM_CHECKPOINT_RANK[checkpoint]) {
    fail("invalid_value", "inspection.previousInspection.checkpoint", "previous inspection must precede the requested checkpoint");
  }
  if (previous.items.length !== flattened.length) {
    fail("invalid_value", "inspection.previousInspection.items", "previous inspection does not cover the Loom policy");
  }
  for (let index = 0; index < flattened.length; index += 1) {
    const expected = flattened[index];
    const item = previous.items[index];
    if (!expected || !item) {
      fail("invalid_value", "inspection.previousInspection.items", "previous inspection does not cover the Loom policy");
    }
    const sourceMatches = item.source.kind === expected.entry.source.kind
      && item.source.blockId === expected.entry.source.blockId
      && item.source.presetRevision === expected.entry.source.presetRevision
      && item.source.blockRevision === expected.entry.source.blockRevision
      && item.source.promptOrder === expected.entry.source.promptOrder;
    const conditionMatches = item.condition === undefined
      ? expected.entry.condition === undefined
      : expected.entry.condition !== undefined
        && JSON.stringify(item.condition) === JSON.stringify(expected.entry.condition);
    if (
      item.entryId !== expected.entry.id
      || item.bucket !== expected.bucket
      || item.destination !== expected.entry.destination
      || item.checkpoint !== expected.entry.checkpoint
      || item.required !== expected.entry.required
      || !item.ordinaryPromptSuppressed
      || !sourceMatches
      || !conditionMatches
    ) {
      fail("invalid_value", `inspection.previousInspection.items[${index}]`, "previous inspection provenance does not match the Loom policy");
    }
  }
  return previous;
}

export function inspectLoomPromptPolicies(policiesValue: unknown, input: LoomPromptInspectionInputV1): LoomPromptInspectionV1 {
  const policies = parseLoomPolicyBuckets(policiesValue);
  const checkpoint = ensureEnum(input.checkpoint, LOOM_POLICY_CHECKPOINTS, "inspection.checkpoint");
  const surface = ensureEnum(input.surface, ["WORK", "RESPONSE"], "inspection.surface");
  const blocksBySource = new Map<string, LoomPromptInspectionBlockV1>();
  if (surface === "WORK") {
    input.blocks.forEach((block, index) => {
      const source = parseLoomPolicySource(block.source, `inspection.blocks[${index}].source`);
      const content = ensureSafeText(block.content, `inspection.blocks[${index}].content`);
      const key = loomPolicySourceKey(source);
      const prior = blocksBySource.get(key);
      if (prior && prior.content !== content) fail("invalid_value", `inspection.blocks[${index}]`, "conflicting Loom block content");
      blocksBySource.set(key, { source, content });
    });
  }
  const evaluation = input.evaluation === undefined ? undefined : parseCognitionEvaluationContext(input.evaluation);
  const items: LoomPromptInspectionItemV1[] = [];
  const effectiveEntryIds: string[] = [];
  const keptByDestinationBlock = new Map<string, string>();
  const conflictingIds = conflictingDestBlockEntryIds(policies);
  const flattened = LOOM_POLICY_BUCKETS.flatMap((bucket) => policies[bucket].map((entry) => ({ bucket, entry })));
  const previous = previousLoomInspection(input, surface, checkpoint, flattened);
  const previousRank = previous === undefined ? -1 : LOOM_CHECKPOINT_RANK[previous.checkpoint];
  for (let index = 0; index < flattened.length; index += 1) {
    const current = flattened[index];
    if (!current) continue;
    const { bucket, entry } = current;
    if (surface === "RESPONSE") {
      items.push(loomPromptInspectionItem(entry, bucket, { status: "omitted", reason: "response_mode" }, null, entry.condition === undefined ? "not_applicable" : "not_evaluated"));
      continue;
    }
    if (previous !== undefined && LOOM_CHECKPOINT_RANK[entry.checkpoint] <= previousRank) {
      const item = previous.items[index];
      if (!item || (item.outcome.status === "skipped" && item.outcome.reason === "checkpoint_not_reached")) {
        fail("invalid_value", `inspection.previousInspection.items[${index}]`, "previous inspection did not decide a reached entry");
      }
      const deduplicationKey = loomDestBlockKey(item.destination, item.source);
      if (item.outcome.status === "included") {
        if (item.outcome.effectiveIndex !== effectiveEntryIds.length || keptByDestinationBlock.has(deduplicationKey)) {
          fail("invalid_value", `inspection.previousInspection.items[${index}].outcome`, "previous inspection inclusion order is invalid");
        }
        keptByDestinationBlock.set(deduplicationKey, item.entryId);
        effectiveEntryIds.push(item.entryId);
      } else if (item.outcome.status === "deduplicated" && keptByDestinationBlock.get(deduplicationKey) !== item.outcome.keptEntryId) {
        fail("invalid_value", `inspection.previousInspection.items[${index}].outcome`, "previous inspection deduplication evidence is invalid");
      }
      items.push(item);
      continue;
    }
    if (conflictingIds.has(entry.id)) {
      items.push(loomPromptInspectionItem(entry, bucket, { status: "rejected", reason: "invalid_source" }, null, entry.condition === undefined ? "not_applicable" : "not_evaluated"));
      continue;
    }
    if (LOOM_CHECKPOINT_RANK[checkpoint] < LOOM_CHECKPOINT_RANK[entry.checkpoint]) {
      items.push(loomPromptInspectionItem(entry, bucket, { status: "skipped", reason: "checkpoint_not_reached" }, null, entry.condition === undefined ? "not_applicable" : "not_evaluated"));
      continue;
    }
    const block = blocksBySource.get(loomPolicySourceKey(entry.source));
    if (!block) {
      items.push(loomPromptInspectionItem(entry, bucket, entry.required ? { status: "rejected", reason: "required_source_unavailable" } : { status: "skipped", reason: "stale_source" }, null, entry.condition === undefined ? "not_applicable" : "not_evaluated"));
      continue;
    }
    let conditionResult: LoomPolicyConditionResultV1 = entry.condition === undefined ? "not_applicable" : "not_evaluated";
    if (entry.condition !== undefined) {
      if (evaluation === undefined) {
        items.push(loomPromptInspectionItem(entry, bucket, entry.required ? { status: "rejected", reason: "required_source_unavailable" } : { status: "skipped", reason: "condition_not_met" }, block.content, conditionResult));
        continue;
      }
      try {
        const matched = evaluateCognitionPredicate(entry.condition, evaluation);
        conditionResult = matched ? "true" : "false";
        if (!matched) {
          items.push(loomPromptInspectionItem(entry, bucket, { status: "skipped", reason: "condition_not_met" }, block.content, conditionResult));
          continue;
        }
      } catch {
        conditionResult = "invalid";
        items.push(loomPromptInspectionItem(entry, bucket, entry.required ? { status: "rejected", reason: "required_source_unavailable" } : { status: "skipped", reason: "condition_not_met" }, block.content, conditionResult));
        continue;
      }
    }
    const deduplicationKey = loomDestBlockKey(entry.destination, entry.source);
    const keptEntryId = keptByDestinationBlock.get(deduplicationKey);
    if (keptEntryId) {
      items.push(loomPromptInspectionItem(entry, bucket, { status: "deduplicated", reason: "destination_overlap", keptEntryId, destination: entry.destination }, block.content, conditionResult));
      continue;
    }
    keptByDestinationBlock.set(deduplicationKey, entry.id);
    effectiveEntryIds.push(entry.id);
    items.push(loomPromptInspectionItem(entry, bucket, { status: "included", effectiveIndex: effectiveEntryIds.length - 1, reason: "selected" }, block.content, conditionResult));
  }
  const responseOmission: LoomResponsePolicyOmissionV1 | undefined = surface === "RESPONSE" ? {
    version: LOOM_POLICY_VERSION,
    surface: "RESPONSE",
    visibility: "work_only",
    reason: "work_only",
    omittedEntryIds: items.map((item) => item.entryId),
    source: items.map((item) => item.source),
    omittedPhaseInstructions: [],
  } : undefined;
  return deepFreeze({ version: LOOM_POLICY_VERSION, surface, checkpoint, items, effectiveEntryIds, ...(responseOmission === undefined ? {} : { responseOmission }) });
}

export const inspectLoomPrompt = inspectLoomPromptPolicies;
export const inspectLoomPromptPoliciesV1 = inspectLoomPromptPolicies;

/** Expose the closed enums for route/editor validators without mutable arrays. */
export const COGNITION_GENERATION_TYPES = Object.freeze([...GENERATION_TYPES]);
export const COGNITION_PHASES = Object.freeze([...PHASES]);
export const COGNITION_TASK_TRANSITIONS = Object.freeze([...TASK_TRANSITIONS]);
