import type {
  AgentConfigV2,
  AgentProfileConfigV2,
  CoreAgentToolId,
} from "../types/agents";
import type { PromptBlock } from "../types/preset";

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RESULT_NAME_PATTERN = PROFILE_ID_PATTERN;
const OPEN_PREFIX = "{{agent::";
const CLOSE_TAG = "{{/agent}}";
const CLOSE_PREFIX = "{{/agent";
const RESULT_PREFIX = "{{agentResult::";
const AGENT_MARKER_PREFIX = "{{agent";

const CORE_TOOL_IDS = [
  "lore_list_books",
  "lore_get_book",
  "lore_list_entries",
  "lore_get_entry",
  "lore_search_entries",
  "chat_search_history",
] as const satisfies readonly CoreAgentToolId[];
const CORE_TOOL_ID_SET: ReadonlySet<string> = new Set(CORE_TOOL_IDS);

/** Closed reasons safe to expose to callers and clients. */
export type AgentIntrinsicValidationReasonCode =
  | "malformed_opening"
  | "malformed_closing"
  | "malformed_reference"
  | "unknown_option"
  | "duplicate_option"
  | "invalid_option"
  | "invalid_profile_id"
  | "invalid_result_name"
  | "empty_task"
  | "nested_intrinsic"
  | "non_user_block"
  | "unknown_profile"
  | "unknown_tool"
  | "tool_not_allowed"
  | "stream_not_allowed"
  | "duplicate_producer"
  | "forward_reference"
  | "missing_reference"
  | "node_limit_exceeded";

export interface AgentIntrinsicBlockIdentity {
  readonly blockIndex: number;
  readonly blockId: string;
}

/**
 * Safe preflight failure. The message deliberately contains no authored task,
 * result value, option value, or other prompt content.
 */
export class AgentIntrinsicValidationError extends Error {
  readonly code = "AGENT_INTRINSIC_INVALID" as const;
  readonly reasonCode: AgentIntrinsicValidationReasonCode;
  readonly reason: AgentIntrinsicValidationReasonCode;
  readonly blockIndex: number;
  readonly blockId: string;

  constructor(
    identity: AgentIntrinsicBlockIdentity,
    reasonCode: AgentIntrinsicValidationReasonCode,
  ) {
    super("Invalid agent intrinsic syntax");
    this.name = "AgentIntrinsicValidationError";
    this.reasonCode = reasonCode;
    this.reason = reasonCode;
    this.blockIndex = identity.blockIndex;
    this.blockId = identity.blockId;
  }
}

export class AgentDryRunUnsupportedError extends Error {
  constructor() {
    super("Agent intrinsics cannot execute during Dry Run");
    this.name = "AgentDryRunUnsupportedError";
  }
}

export class AgentMultiplayerUnsupportedError extends Error {
  constructor() {
    super("Agent intrinsics are unavailable in active multiplayer rooms");
    this.name = "AgentMultiplayerUnsupportedError";
  }
}

export class AgentAssemblyRequiresMainProcessError extends Error {
  constructor() {
    super("Agent execution requires main-process prompt assembly");
    this.name = "AgentAssemblyRequiresMainProcessError";
  }
}
export interface AgentFeatureAdmissionInput {
  readonly config?: AgentConfigV2;
  readonly hasExecutableIntrinsic: boolean;
  readonly dryRun: boolean;
  readonly activeMultiplayer: boolean;
}

/**
 * Apply mode restrictions before allocating the main-process runtime.
 * Multiplayer omits main-model tools/delegation, but authored intrinsics fail
 * rather than disappearing silently.
 */
export function resolveAgentFeatureRuntimeAdmission(
  input: AgentFeatureAdmissionInput,
): boolean {
  if (input.hasExecutableIntrinsic && input.dryRun) {
    throw new AgentDryRunUnsupportedError();
  }
  if (input.hasExecutableIntrinsic && input.activeMultiplayer) {
    throw new AgentMultiplayerUnsupportedError();
  }
  if (
    input.config?.agentsEnabled !== true ||
    input.dryRun ||
    input.activeMultiplayer
  ) {
    return false;
  }
  return (
    input.hasExecutableIntrinsic ||
    input.config.mainToolIds.length > 0 ||
    input.config.profiles.some((profile) => profile.allowMainDelegation)
  );
}


/** The normalized effective block fields required by preflight. */
export type AgentIntrinsicBlockInput = Pick<PromptBlock, "id" | "content" | "role"> &
  Partial<Pick<PromptBlock, "enabled">> & {
    /**
     * Whether this block is actually traversed by prompt assembly for the
     * current generation. Trigger- and tag-skipped blocks must not participate
     * in feature validation or producer/reference ordering.
     */
    active?: boolean;
  };
export interface AgentIntrinsicInvocationPlan extends AgentIntrinsicBlockIdentity {
  readonly kind: "intrinsic";
  readonly start: number;
  readonly end: number;
  readonly profileId: string;
  readonly profile: AgentProfileConfigV2;
  readonly taskTemplate: string;
  readonly resultName?: string;
  /** Effective tool grant after applying an optional tools= narrowing. */
  readonly toolIds: readonly CoreAgentToolId[];
  /** True only when the author requested ::stream and the profile permits it. */
  readonly stream: boolean;
}

export interface AgentResultReferencePlan extends AgentIntrinsicBlockIdentity {
  readonly kind: "result_reference";
  readonly start: number;
  readonly end: number;
  readonly resultName: string;
}

export type AgentIntrinsicNodePlan =
  | AgentIntrinsicInvocationPlan
  | AgentResultReferencePlan;

export interface AgentIntrinsicBlockPlan extends AgentIntrinsicBlockIdentity {
  readonly originalContent: string;
  /**
   * For a disabled present config this strips valid intrinsic syntax and
   * references. Otherwise it is byte-for-byte originalContent.
   */
  readonly replacementContent: string;
  readonly intrinsic: AgentIntrinsicInvocationPlan | null;
  readonly resultReferences: readonly AgentResultReferencePlan[];
  readonly nodes: readonly AgentIntrinsicNodePlan[];
}

export interface AgentIntrinsicTraversalPlan {
  readonly configPresent: boolean;
  readonly agentsEnabled: boolean;
  /** Blocks and all contained nodes are ordered by effective block traversal. */
  readonly blocks: readonly AgentIntrinsicBlockPlan[];
  readonly nodes: readonly AgentIntrinsicNodePlan[];
  readonly executableIntrinsics: readonly AgentIntrinsicInvocationPlan[];
  readonly resultReferences: readonly AgentResultReferencePlan[];
  readonly nodeCount: number;
}

interface ParsedOpening {
  readonly profileId: string;
  readonly resultName?: string;
  readonly requestedToolIds: readonly CoreAgentToolId[] | null;
  readonly stream: boolean;
}

interface ParsedBlock {
  readonly intrinsic: AgentIntrinsicInvocationPlan | null;
  readonly resultReferences: readonly AgentResultReferencePlan[];
  readonly nodes: readonly AgentIntrinsicNodePlan[];
}

function identityFor(
  block: AgentIntrinsicBlockInput,
  blockIndex: number,
): AgentIntrinsicBlockIdentity {
  return { blockIndex, blockId: block.id };
}

function fail(
  identity: AgentIntrinsicBlockIdentity,
  reasonCode: AgentIntrinsicValidationReasonCode,
): never {
  throw new AgentIntrinsicValidationError(identity, reasonCode);
}

function isFeatureMarkerStart(content: string, markerIndex: number): boolean {
  const tail = content.slice(markerIndex);
  if (tail.startsWith(CLOSE_PREFIX)) {
    const next = tail.slice(CLOSE_PREFIX.length, CLOSE_PREFIX.length + 1);
    return next === "}" || next === ":" || next === "";
  }
  if (tail.startsWith("{{agentResult")) {
    const next = tail.slice("{{agentResult".length, "{{agentResult".length + 1);
    return next === ":" || next === "}" || next === "";
  }
  if (tail.startsWith(AGENT_MARKER_PREFIX)) {
    const next = tail.slice(AGENT_MARKER_PREFIX.length, AGENT_MARKER_PREFIX.length + 1);
    return next === ":" || next === "}" || next === "";
  }
  return false;
}

function findFeatureMarker(content: string, fromIndex: number): number {
  let cursor = Math.max(0, fromIndex);
  while (true) {
    const markerIndex = content.indexOf("{{", cursor);
    if (markerIndex < 0) return -1;
    if (isFeatureMarkerStart(content, markerIndex)) return markerIndex;
    cursor = markerIndex + 2;
  }
}

function containsFeatureMarker(content: string): boolean {
  return findFeatureMarker(content, 0) >= 0;
}

function parseToolList(
  raw: string,
  identity: AgentIntrinsicBlockIdentity,
): readonly CoreAgentToolId[] {
  if (!raw) fail(identity, "invalid_option");
  const seen = new Set<string>();
  const toolIds: CoreAgentToolId[] = [];
  for (const rawToolId of raw.split(",")) {
    if (!rawToolId || !CORE_TOOL_ID_SET.has(rawToolId)) {
      fail(identity, "unknown_tool");
    }
    if (seen.has(rawToolId)) fail(identity, "duplicate_option");
    seen.add(rawToolId);
    toolIds.push(rawToolId as CoreAgentToolId);
  }
  return toolIds;
}

function parseOpening(
  opening: string,
  identity: AgentIntrinsicBlockIdentity,
): ParsedOpening {
  if (!opening.startsWith(OPEN_PREFIX) || !opening.endsWith("}}")) {
    fail(identity, "malformed_opening");
  }

  const body = opening.slice(OPEN_PREFIX.length, -2);
  const segments = body.split("::");
  const profileId = segments.shift() ?? "";
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    fail(identity, "invalid_profile_id");
  }

  const seenOptions = new Set<string>();
  let resultName: string | undefined;
  let requestedToolIds: readonly CoreAgentToolId[] | null = null;
  let stream = false;

  for (const option of segments) {
    if (!option) fail(identity, "invalid_option");
    const equalsIndex = option.indexOf("=");
    const key = equalsIndex < 0 ? option : option.slice(0, equalsIndex);
    if (key !== "as" && key !== "tools" && key !== "stream") {
      fail(identity, "unknown_option");
    }
    if (seenOptions.has(key)) fail(identity, "duplicate_option");
    seenOptions.add(key);

    if (key === "stream") {
      if (equalsIndex >= 0) fail(identity, "invalid_option");
      stream = true;
      continue;
    }

    if (equalsIndex < 0 || equalsIndex === option.length - 1) {
      fail(identity, "invalid_option");
    }
    if (option.lastIndexOf("=") !== equalsIndex) {
      fail(identity, "invalid_option");
    }

    const value = option.slice(equalsIndex + 1);
    if (key === "as") {
      if (!RESULT_NAME_PATTERN.test(value)) {
        fail(identity, "invalid_result_name");
      }
      resultName = value;
      continue;
    }

    requestedToolIds = parseToolList(value, identity);
  }

  return { profileId, resultName, requestedToolIds, stream };
}

function getProfile(
  config: AgentConfigV2,
  profileId: string,
  identity: AgentIntrinsicBlockIdentity,
): AgentProfileConfigV2 {
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) fail(identity, "unknown_profile");
  return profile;
}

function authorizeOpening(
  opening: ParsedOpening,
  config: AgentConfigV2,
  block: AgentIntrinsicBlockInput,
  identity: AgentIntrinsicBlockIdentity,
): AgentIntrinsicInvocationPlan {
  if (block.role !== "user") fail(identity, "non_user_block");

  const profile = getProfile(config, opening.profileId, identity);
  const profileToolIds = new Set<string>(profile.toolIds);
  const effectiveToolIds = opening.requestedToolIds
    ? [...opening.requestedToolIds]
    : [...profile.toolIds];
  if (opening.requestedToolIds) {
    for (const toolId of opening.requestedToolIds) {
      if (!profileToolIds.has(toolId)) fail(identity, "tool_not_allowed");
    }
  }
  if (opening.stream && !profile.streamActivity) {
    fail(identity, "stream_not_allowed");
  }

  return {
    ...identity,
    kind: "intrinsic",
    start: 0,
    end: block.content.length,
    profileId: opening.profileId,
    profile,
    taskTemplate: "",
    resultName: opening.resultName,
    toolIds: effectiveToolIds,
    stream: opening.stream,
  };

}

function parseWholeIntrinsic(
  block: AgentIntrinsicBlockInput,
  identity: AgentIntrinsicBlockIdentity,
  config: AgentConfigV2,
): AgentIntrinsicInvocationPlan {
  const content = block.content;
  const openingEnd = content.indexOf("}}", OPEN_PREFIX.length);
  if (openingEnd < 0) fail(identity, "malformed_opening");

  const opening = content.slice(0, openingEnd + 2);
  const closePrefixIndex = content.indexOf(CLOSE_PREFIX, openingEnd + 2);
  const closeIndex = content.indexOf(CLOSE_TAG, openingEnd + 2);
  if (closePrefixIndex < 0 || closeIndex < 0 || closePrefixIndex !== closeIndex) {
    fail(identity, "malformed_closing");
  }

  const taskTemplate = content.slice(openingEnd + 2, closeIndex);
  if (containsFeatureMarker(taskTemplate)) fail(identity, "nested_intrinsic");
  if (closeIndex + CLOSE_TAG.length !== content.length) {
    fail(identity, "malformed_closing");
  }
  if (taskTemplate.trim().length === 0) fail(identity, "empty_task");

  const parsedOpening = parseOpening(opening, identity);
  const authorized = authorizeOpening(parsedOpening, config, block, identity);
  return { ...authorized, taskTemplate };
}

function parseResultReferences(
  block: AgentIntrinsicBlockInput,
  identity: AgentIntrinsicBlockIdentity,
): readonly AgentResultReferencePlan[] {
  const references: AgentResultReferencePlan[] = [];
  let cursor = 0;
  while (true) {
    const markerIndex = findFeatureMarker(block.content, cursor);
    if (markerIndex < 0) break;

    if (block.content.startsWith(CLOSE_PREFIX, markerIndex)) {
      fail(identity, "malformed_closing");
    }
    if (block.content.startsWith(OPEN_PREFIX, markerIndex)) {
      fail(identity, "malformed_opening");
    }
    if (!block.content.startsWith("{{agentResult", markerIndex)) {
      fail(identity, "malformed_opening");
    }
    if (!block.content.startsWith(RESULT_PREFIX, markerIndex)) {
      fail(identity, "malformed_reference");
    }

    const endMarker = block.content.indexOf("}}", markerIndex + RESULT_PREFIX.length);
    if (endMarker < 0) fail(identity, "malformed_reference");
    const resultName = block.content.slice(markerIndex + RESULT_PREFIX.length, endMarker);
    if (!RESULT_NAME_PATTERN.test(resultName)) {
      fail(identity, "invalid_result_name");
    }
    if (block.role !== "user") fail(identity, "non_user_block");
    references.push({
      ...identity,
      kind: "result_reference",
      start: markerIndex,
      end: endMarker + 2,
      resultName,
    });
    cursor = endMarker + 2;
  }
  return references;
}

function parseBlock(
  block: AgentIntrinsicBlockInput,
  blockIndex: number,
  config: AgentConfigV2,
): ParsedBlock {
  const identity = identityFor(block, blockIndex);
  if (block.content.startsWith(OPEN_PREFIX)) {
    const intrinsic = parseWholeIntrinsic(block, identity, config);
    return { intrinsic, resultReferences: [], nodes: [intrinsic] };
  }

  const resultReferences = parseResultReferences(block, identity);
  return {
    intrinsic: null,
    resultReferences,
    nodes: resultReferences,
  };
}

function removeSpans(
  content: string,
  spans: readonly AgentResultReferencePlan[],
): string {
  if (spans.length === 0) return content;
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(content.slice(cursor, span.start));
    cursor = span.end;
  }
  pieces.push(content.slice(cursor));
  return pieces.join("");
}

function validateResultOrdering(
  blocks: readonly AgentIntrinsicBlockPlan[],
): void {
  const producers = new Map<string, AgentIntrinsicInvocationPlan>();
  for (const block of blocks) {
    const intrinsic = block.intrinsic;
    if (!intrinsic?.resultName) continue;
    if (producers.has(intrinsic.resultName)) {
      fail(block, "duplicate_producer");
    }
    producers.set(intrinsic.resultName, intrinsic);
  }

  for (const block of blocks) {
    for (const reference of block.resultReferences) {
      const producer = producers.get(reference.resultName);
      if (!producer) fail(reference, "missing_reference");
      if (producer.blockIndex >= reference.blockIndex) {
        fail(reference, "forward_reference");
      }
    }
  }
}

/**
 * Parse and authorize feature-local agent syntax before ordinary macro work.
 * A missing config is intentionally inert: no syntax is inspected and every
 * replacementContent is byte-for-byte identical to authored content.
 */
export function preflightAgentIntrinsics(
  blocks: readonly AgentIntrinsicBlockInput[],
  config: AgentConfigV2 | undefined,
): AgentIntrinsicTraversalPlan {
  if (!config) {
    const plans: AgentIntrinsicBlockPlan[] = blocks.map((block, blockIndex) => ({
      ...identityFor(block, blockIndex),
      originalContent: block.content,
      replacementContent: block.content,
      intrinsic: null,
      resultReferences: [],
      nodes: [],
    }));
    return {
      configPresent: false,
      agentsEnabled: false,
      blocks: plans,
      nodes: [],
      executableIntrinsics: [],
      resultReferences: [],
      nodeCount: 0,
    };
  }

  const plans: AgentIntrinsicBlockPlan[] = [];
  let nodeCount = 0;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (block.active === false || block.enabled === false) {
      plans.push({
        ...identityFor(block, blockIndex),
        originalContent: block.content,
        replacementContent: block.content,
        intrinsic: null,
        resultReferences: [],
        nodes: [],
      });
      continue;
    }
    const parsed = parseBlock(block, blockIndex, config);
    nodeCount += parsed.nodes.length;
    if (nodeCount > 32) {
      fail(identityFor(block, blockIndex), "node_limit_exceeded");
    }
    const replacementContent = config.agentsEnabled
      ? block.content
      : parsed.intrinsic
        ? ""
        : removeSpans(block.content, parsed.resultReferences);
    plans.push({
      ...identityFor(block, blockIndex),
      originalContent: block.content,
      replacementContent,
      intrinsic: parsed.intrinsic,
      resultReferences: parsed.resultReferences,
      nodes: parsed.nodes,
    });
  }

  validateResultOrdering(plans);
  const nodes = plans.flatMap((block) => block.nodes);
  const executableIntrinsics = plans.flatMap((block) =>
    block.intrinsic ? [block.intrinsic] : [],
  );
  const resultReferences = plans.flatMap((block) => [...block.resultReferences]);
  return {
    configPresent: true,
    agentsEnabled: config.agentsEnabled,
    blocks: plans,
    nodes,
    executableIntrinsics,
    resultReferences,
    nodeCount,
  };
}

/** Alias used by callers that describe this operation as planning. */
export const planAgentIntrinsics = preflightAgentIntrinsics;
