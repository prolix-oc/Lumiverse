import type {
  FrozenRegexScriptV1,
  InputRevisionSetV1,
  PreparationDeltaV1,
  PreparationFailureCode,
  PreparationLimitsV1,
  RenderContentV1,
  RenderMacroSnapshotV1,
  RenderPreparationInputV1,
  RenderPreparationResultV1,
} from "../types/agent-preprocessing";
import {
  HOST_PREPARATION_LIMITS_V1,
  INPUT_REVISION_KINDS_V1,
  INPUT_REVISION_SET_PROJECTION_KEYS_V1,
  lowerPreparationLimitsV1,
  utf8ByteLength,
} from "../types/agent-preprocessing";
import {
  CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
  CanonicalDataError,
  cloneCanonicalPlainData,
  encodeCanonicalPlainData,
  validateCanonicalPlainData,
} from "../utils/canonical-plain-data";

type Dict = Record<string, unknown>;

/**
 * Identifier, enum, and digest fields carry identity rather than payload. They
 * are bounded far below the per-operation ceiling so a hostile snapshot cannot
 * spend the aggregate textual budget on metadata.
 */
const MAX_IDENTIFIER_BYTES = 512;
const MAX_ENUM_BYTES = 64;
const MAX_DIGEST_BYTES = 128;
/** Matches the compiler/WORK closed revision-identity bound (256 UTF-8 bytes). */
const MAX_REVISION_BYTES = 256;
const MAX_VARIABLE_KEY_BYTES = 512;
const MAX_MIME_TYPE_BYTES = 256;
const MAX_REGEX_FLAG_BYTES = 16;
const MAX_TRIM_STRING_BYTES = 512;
const MAX_REGEX_ACTIONS = 64;
const MAX_INPUT_REVISIONS = 1024;
const MAX_MACRO_DEPENDENCIES = 1024;

const RENDER_TARGET_KINDS = ["normal", "continue", "regenerate", "swipe"] as const;
const RENDER_MEDIA_KINDS = ["image", "audio", "video", "file"] as const;
const SOURCE_MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
const MACRO_SNAPSHOT_GROUPS = ["local", "global", "chat", "promptVariables"] as const;
const MACRO_PURITIES = ["pure", "non_pure"] as const;
const MACRO_DEPENDENCY_SOURCES = ["host", "preset", "extension", "callback"] as const;
const REGEX_ACTION_TYPES = ["send", "append", "effects"] as const;

/** A closed, stable error emitted by the strict render operation. */
export class RenderPreparationValidationError extends Error {
  readonly code: PreparationFailureCode;
  readonly path?: string;

  constructor(code: PreparationFailureCode, message: string, path?: string) {
    super(message);
    this.name = "RenderPreparationValidationError";
    this.code = code;
    this.path = path;
  }
}

export function utf8ByteLengthV1(value: string): number {
  return utf8ByteLength(value);
}

function fail(message: string, path?: string): never {
  throw new RenderPreparationValidationError("invalid_input", message, path);
}

function limitExceeded(message: string, path?: string): never {
  throw new RenderPreparationValidationError("limit_exceeded", message, path);
}
function cloneClosedData(value: unknown, path: string, maxBytes: number): unknown {
  try {
    return cloneCanonicalPlainData(value, { ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1, maxBytes });
  } catch (error) {
    if (error instanceof CanonicalDataError && error.code === "limit_exceeded") {
      limitExceeded(`${path} exceeds the canonical data ${error.dimension ?? "structure"} limit`, path);
    }
    fail("canonical data is not closed plain data", path);
  }
}

function ensureObject(value: unknown, path: string): Dict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected an object", path);
  return value as Dict;
}

function rejectUnknownKeys(value: Dict, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`unknown field ${key}`, `${path}.${key}`);
  }
}

/** Validate a string field and return its exact UTF-8 size without copying it. */
function stringBytes(value: unknown, path: string, maxBytes: number): number {
  if (typeof value !== "string") fail("expected a string", path);
  const bytes = utf8ByteLength(value);
  if (bytes > maxBytes) limitExceeded(`${path} exceeds its UTF-8 byte limit`, path);
  return bytes;
}

function ensureString(value: unknown, path: string, maxBytes: number): string {
  stringBytes(value, path, maxBytes);
  return value as string;
}

function ensureEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`unsupported value at ${path}`, path);
  }
  return value as T;
}

function ensureBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("expected a boolean", path);
  return value;
}

function ensureSafeInteger(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`expected a safe integer between ${min} and ${max}`, path);
  }
  return value as number;
}


/**
 * Reject accessors, prototypes, symbols, cycles, unsafe numbers, and excessive
 * structure before any field-level validator reads the value. The canonical
 * walk is iterative, so malformed host objects cannot recurse through this
 * boundary or invoke an accessor during validation.
 */
function validateClosedPlainData(
  value: unknown,
  path: string,
  maxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes,
): void {
  try {
    validateCanonicalPlainData(value, { ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1, maxBytes });
  } catch (error) {
    if (error instanceof CanonicalDataError && error.code === "limit_exceeded") {
      limitExceeded(`${path} exceeds the canonical data ${error.dimension ?? "structure"} limit`, path);
    }
    fail("value must be closed plain data", path);
  }
}
function ensureArray(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) fail("expected an array", path);
  if (value.length > maxLength) limitExceeded(`${path} exceeds its item limit`, path);
  return value;
}

function ensureVersion(value: unknown, path: string): void {
  if (value !== 1) fail("unsupported version", path);
}

function ensureOperation(value: unknown, path: string): void {
  if (value !== "prepare_agent_render") fail("unsupported operation", path);
}

/** A revision is either a bounded string or a safe integer; nothing else. */
function validateRevisionValue(value: unknown, path: string): void {
  if (typeof value === "string") {
    stringBytes(value, path, MAX_REVISION_BYTES);
    return;
  }
  ensureSafeInteger(value, path, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

/**
 * Validate one render content value and return its exact textual size. Media
 * bytes never enter text transformation, but their metadata does and is
 * therefore counted like any other textual field.
 */
function renderContentBytes(
  value: unknown,
  path: string,
  limits: PreparationLimitsV1,
  byteLimit: number,
): number {
  const content = ensureObject(value, path);
  rejectUnknownKeys(content, ["kind", "text", "parts"], path);
  const kind = ensureEnum(content.kind, ["text", "parts"] as const, `${path}.kind`);
  if (kind === "text") {
    if (content.parts !== undefined) fail("text render content cannot carry parts", `${path}.parts`);
    return content.text === undefined ? 0 : stringBytes(content.text, `${path}.text`, byteLimit);
  }
  if (content.text !== undefined) fail("parts render content cannot carry text", `${path}.text`);
  const parts = ensureArray(content.parts, `${path}.parts`, limits.maxPromptBlocks);
  let bytes = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const partPath = `${path}.parts[${index}]`;
    const part = ensureObject(parts[index], partPath);
    const partKind = ensureEnum(part.kind, ["text", "media"] as const, `${partPath}.kind`);
    if (partKind === "text") {
      rejectUnknownKeys(part, ["kind", "text"], partPath);
      bytes += stringBytes(part.text, `${partPath}.text`, byteLimit);
    } else {
      rejectUnknownKeys(part, ["kind", "mediaKind", "mimeType", "reference", "altText"], partPath);
      ensureEnum(part.mediaKind, RENDER_MEDIA_KINDS, `${partPath}.mediaKind`);
      bytes += utf8ByteLength(part.mediaKind as string);
      bytes += stringBytes(part.mimeType, `${partPath}.mimeType`, MAX_MIME_TYPE_BYTES);
      bytes += stringBytes(part.reference, `${partPath}.reference`, limits.maxOperationBytes);
      if (part.altText !== undefined) {
        bytes += stringBytes(part.altText, `${partPath}.altText`, limits.maxOperationBytes);
      }
    }
    if (bytes > byteLimit) limitExceeded(`${path} exceeds its byte limit`, path);
  }
  return bytes;
}

function validateTarget(value: unknown): void {
  const target = ensureObject(value, "target");
  rejectUnknownKeys(target, ["kind", "messageId", "swipeId", "branchId"], "target");
  ensureEnum(target.kind, RENDER_TARGET_KINDS, "target.kind");
  if (target.messageId !== undefined) validateRevisionValue(target.messageId, "target.messageId");
  if (target.swipeId !== undefined) validateRevisionValue(target.swipeId, "target.swipeId");
  if (target.branchId !== undefined) ensureString(target.branchId, "target.branchId", MAX_IDENTIFIER_BYTES);
}

function validateSourceMessages(value: unknown, limits: PreparationLimitsV1): void {
  const messages = ensureArray(value, "sourceMessages", limits.maxPromptBlocks);
  const ids = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const path = `sourceMessages[${index}]`;
    const message = ensureObject(messages[index], path);
    rejectUnknownKeys(message, ["sourceMessageId", "revision", "role", "content", "swipeId", "authorName"], path);
    const id = ensureString(message.sourceMessageId, `${path}.sourceMessageId`, MAX_IDENTIFIER_BYTES);
    if (ids.has(id)) fail("duplicate source message id", `${path}.sourceMessageId`);
    ids.add(id);
    ensureEnum(message.role, SOURCE_MESSAGE_ROLES, `${path}.role`);
    validateRevisionValue(message.revision, `${path}.revision`);
    if (message.swipeId !== undefined) {
      ensureSafeInteger(message.swipeId, `${path}.swipeId`, 0, Number.MAX_SAFE_INTEGER);
    }
    renderContentBytes(message.content, `${path}.content`, limits, limits.maxInputBytes);
    if (message.authorName !== undefined) {
      ensureString(message.authorName, `${path}.authorName`, MAX_IDENTIFIER_BYTES);
    }
  }
}

function validateSwipes(value: unknown, limits: PreparationLimitsV1): void {
  const swipes = ensureArray(value, "swipes", limits.maxPromptBlocks);
  const ids = new Set<string>();
  for (let index = 0; index < swipes.length; index += 1) {
    const path = `swipes[${index}]`;
    const swipe = ensureObject(swipes[index], path);
    rejectUnknownKeys(swipe, ["swipeId", "index", "revision", "content", "slot"], path);
    const id = ensureString(swipe.swipeId, `${path}.swipeId`, MAX_IDENTIFIER_BYTES);
    if (ids.has(id)) fail("duplicate swipe id", `${path}.swipeId`);
    ids.add(id);
    ensureSafeInteger(swipe.index, `${path}.index`, 0, limits.maxPromptBlocks);
    validateRevisionValue(swipe.revision, `${path}.revision`);
    if (swipe.slot !== undefined) ensureEnum(swipe.slot, ["append"] as const, `${path}.slot`);
    renderContentBytes(swipe.content, `${path}.content`, limits, limits.maxInputBytes);
  }
}

function validateMacroSnapshot(value: unknown, limits: PreparationLimitsV1): void {
  const snapshot = ensureObject(value, "macroSnapshot");
  rejectUnknownKeys(snapshot, [...MACRO_SNAPSHOT_GROUPS, "dependencies"], "macroSnapshot");
  for (const group of MACRO_SNAPSHOT_GROUPS) {
    const entries = ensureArray(snapshot[group], `macroSnapshot.${group}`, limits.maxPromptBlocks);
    for (let index = 0; index < entries.length; index += 1) {
      const path = `macroSnapshot.${group}[${index}]`;
      const tuple = entries[index];
      if (!Array.isArray(tuple) || tuple.length !== 2) {
        fail("macro snapshot entries must be key/value tuples", path);
      }
      stringBytes(tuple[0], `${path}[0]`, MAX_VARIABLE_KEY_BYTES);
      stringBytes(tuple[1], `${path}[1]`, limits.maxOperationBytes);
    }
  }
  if (snapshot.dependencies === undefined) return;
  const dependencies = ensureArray(snapshot.dependencies, "macroSnapshot.dependencies", MAX_MACRO_DEPENDENCIES);
  for (let index = 0; index < dependencies.length; index += 1) {
    const path = `macroSnapshot.dependencies[${index}]`;
    const dependency = ensureObject(dependencies[index], path);
    rejectUnknownKeys(dependency, ["name", "purity", "source"], path);
    ensureString(dependency.name, `${path}.name`, MAX_IDENTIFIER_BYTES);
    ensureEnum(dependency.purity, MACRO_PURITIES, `${path}.purity`);
    ensureEnum(dependency.source, MACRO_DEPENDENCY_SOURCES, `${path}.source`);
  }
}

function validateRegexScripts(value: unknown, limits: PreparationLimitsV1): void {
  const scripts = ensureArray(value, "regexScripts", limits.maxActiveScripts);
  const ids = new Set<string>();
  let patternCount = 0;
  for (let index = 0; index < scripts.length; index += 1) {
    const path = `regexScripts[${index}]`;
    const script = ensureObject(scripts[index], path);
    rejectUnknownKeys(script, [
      "scriptId",
      "revision",
      "pattern",
      "replacement",
      "flags",
      "stage",
      "enabled",
      "order",
      "trimStrings",
      "actions",
    ], path);
    const id = ensureString(script.scriptId, `${path}.scriptId`, MAX_IDENTIFIER_BYTES);
    if (ids.has(id)) fail("duplicate regex script id", `${path}.scriptId`);
    ids.add(id);
    validateRevisionValue(script.revision, `${path}.revision`);
    const pattern = ensureString(script.pattern, `${path}.pattern`, limits.maxOperationBytes);
    stringBytes(script.replacement, `${path}.replacement`, limits.maxOperationBytes);
    const flags = ensureString(script.flags, `${path}.flags`, MAX_REGEX_FLAG_BYTES);
    ensureEnum(script.stage, ["response"] as const, `${path}.stage`);
    ensureBoolean(script.enabled, `${path}.enabled`);
    ensureSafeInteger(script.order, `${path}.order`, 0, limits.maxActiveScripts);
    if (script.trimStrings !== undefined) {
      const trims = ensureArray(script.trimStrings, `${path}.trimStrings`, limits.maxTrimStrings);
      for (let trimIndex = 0; trimIndex < trims.length; trimIndex += 1) {
        const trimPath = `${path}.trimStrings[${trimIndex}]`;
        const bytes = stringBytes(trims[trimIndex], trimPath, MAX_TRIM_STRING_BYTES);
        // An empty trim can never make progress, so it is rejected instead of
        // being applied as an unbounded no-op loop.
        if (bytes === 0) fail("regex trim strings must be non-empty", trimPath);
      }
    }
    if (script.actions !== undefined) {
      const actions = ensureArray(script.actions, `${path}.actions`, MAX_REGEX_ACTIONS);
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const actionPath = `${path}.actions[${actionIndex}]`;
        const action = ensureObject(actions[actionIndex], actionPath);
        rejectUnknownKeys(action, ["id", "type"], actionPath);
        ensureString(action.id, `${actionPath}.id`, MAX_IDENTIFIER_BYTES);
        ensureEnum(action.type, REGEX_ACTION_TYPES, `${actionPath}.type`);
      }
    }
    patternCount += 1;
    if (patternCount > limits.maxCompiledPatterns) {
      limitExceeded("compiled patterns exceed the limit", "regexScripts");
    }
    try {
      new RegExp(pattern, flags);
    } catch {
      fail("invalid response regex", `${path}.pattern`);
    }
  }
}

function validateFormatting(value: unknown, limits: PreparationLimitsV1): void {
  const formatting = ensureObject(value, "formatting");
  rejectUnknownKeys(formatting, [
    "stripGuidedReasoning",
    "healFormatting",
    "preserveProviderReasoning",
    "reasoningDelimiters",
  ], "formatting");
  ensureBoolean(formatting.stripGuidedReasoning, "formatting.stripGuidedReasoning");
  ensureBoolean(formatting.healFormatting, "formatting.healFormatting");
  ensureBoolean(formatting.preserveProviderReasoning, "formatting.preserveProviderReasoning");
  if (formatting.reasoningDelimiters === undefined) return;
  const delimiters = ensureObject(formatting.reasoningDelimiters, "formatting.reasoningDelimiters");
  rejectUnknownKeys(delimiters, ["prefix", "suffix"], "formatting.reasoningDelimiters");
  stringBytes(delimiters.prefix, "formatting.reasoningDelimiters.prefix", limits.maxOperationBytes);
  stringBytes(delimiters.suffix, "formatting.reasoningDelimiters.suffix", limits.maxOperationBytes);
}

function validateRevisionSet(value: unknown, path: string): void {
  const set = ensureObject(value, path);
  rejectUnknownKeys(set, ["version", "revisions", "digest", ...INPUT_REVISION_SET_PROJECTION_KEYS_V1], path);
  ensureVersion(set.version, `${path}.version`);
  ensureString(set.digest, `${path}.digest`, MAX_DIGEST_BYTES);
  const revisions = ensureArray(set.revisions, `${path}.revisions`, MAX_INPUT_REVISIONS);
  const revisionKeys = new Set<string>();
  for (let index = 0; index < revisions.length; index += 1) {
    const revisionPath = `${path}.revisions[${index}]`;
    const revision = ensureObject(revisions[index], revisionPath);
    rejectUnknownKeys(revision, ["kind", "domain", "id", "revision", "digest"], revisionPath);
    const kind = ensureEnum(revision.kind, INPUT_REVISION_KINDS_V1, `${revisionPath}.kind`);
    if (revision.domain !== undefined && revision.domain !== kind) {
      fail("revision domain must match its kind", `${revisionPath}.domain`);
    }
    const id = ensureString(revision.id, `${revisionPath}.id`, MAX_IDENTIFIER_BYTES);
    validateRevisionValue(revision.revision, `${revisionPath}.revision`);
    ensureString(revision.digest, `${revisionPath}.digest`, MAX_DIGEST_BYTES);
    const identity = `${kind}\u0000${id}`;
    if (revisionKeys.has(identity)) fail("duplicate canonical revision identity", revisionPath);
    revisionKeys.add(identity);
  }

  const encodedRevisions = new WeakMap<object, string>();
  const canonicalValue = (entry: unknown): string => {
    if (entry && typeof entry === "object") {
      const cached = encodedRevisions.get(entry);
      if (cached !== undefined) return cached;
    }
    const encoded = encodeCanonicalPlainData(entry, {
      ...CANONICAL_SNAPSHOT_DATA_LIMITS_V1,
      maxBytes: HOST_PREPARATION_LIMITS_V1.maxInputBytes,
    });
    if (entry && typeof entry === "object") encodedRevisions.set(entry, encoded);
    return encoded;
  };
  const equalProjection = (actual: unknown[], expected: readonly unknown[], projectionPath: string): void => {
    if (actual.length !== expected.length) fail("revision projection length does not match canonical revisions", projectionPath);
    for (let index = 0; index < expected.length; index += 1) {
      if (canonicalValue(actual[index]) !== canonicalValue(expected[index])) {
        fail("revision projection is not an exact canonical alias", `${projectionPath}[${index}]`);
      }
    }
  };
  const byKind = (kind: (typeof INPUT_REVISION_KINDS_V1)[number]): readonly unknown[] =>
    revisions.filter((revision) => (revision as Dict).kind === kind);
  const expectedProjection = (projection: (typeof INPUT_REVISION_SET_PROJECTION_KEYS_V1)[number]): readonly unknown[] => {
    switch (projection) {
      case "entries":
        return revisions;
      case "target":
        return byKind("target");
      case "chat":
        return byKind("chat");
      case "messages":
        return byKind("message");
      case "preset":
        return byKind("preset");
      case "blocks":
        return byKind("preset_block");
      case "config":
        return byKind("config");
      case "slotBinding":
        return byKind("slot_binding");
      case "connection":
        return byKind("connection");
      case "endpoint":
        return byKind("endpoint");
      case "credential":
        return byKind("credential");
      case "participants":
        return [...byKind("persona"), ...byKind("character"), ...byKind("group")];
      case "worldLore":
        return byKind("world_lore");
      case "databank":
        return byKind("databank");
      case "settings":
        return byKind("settings");
      case "variables":
        return byKind("macro_variables");
      case "regex":
        return byKind("regex");
      case "cognition":
        return byKind("cognition_policy");
      case "readiness":
        return byKind("readiness");
    }
  };
  for (const projection of INPUT_REVISION_SET_PROJECTION_KEYS_V1) {
    if (set[projection] === undefined) continue;
    const actual = ensureArray(set[projection], `${path}.${projection}`, MAX_INPUT_REVISIONS);
    equalProjection(actual, expectedProjection(projection), `${path}.${projection}`);
  }
}

function validateDeltas(value: unknown, limits: PreparationLimitsV1, path: string): void {
  const deltas = ensureArray(value, path, limits.maxPromptBlocks);
  for (let index = 0; index < deltas.length; index += 1) {
    const deltaPath = `${path}[${index}]`;
    const delta = ensureObject(deltas[index], deltaPath);
    const kind = ensureString(delta.kind, `${deltaPath}.kind`, MAX_ENUM_BYTES);
    switch (kind) {
      case "macro_variable":
        rejectUnknownKeys(delta, ["kind", "scope", "key", "operation", "value", "expectedRevision"], deltaPath);
        ensureEnum(delta.scope, ["local", "global", "chat"] as const, `${deltaPath}.scope`);
        ensureEnum(delta.operation, ["set", "delete"] as const, `${deltaPath}.operation`);
        ensureString(delta.key, `${deltaPath}.key`, MAX_VARIABLE_KEY_BYTES);
        if (delta.value !== undefined) stringBytes(delta.value, `${deltaPath}.value`, limits.maxOperationBytes);
        if (delta.expectedRevision !== undefined) validateRevisionValue(delta.expectedRevision, `${deltaPath}.expectedRevision`);
        break;
      case "world_info_state":
        rejectUnknownKeys(delta, ["kind", "entryId", "operation", "state", "afterState", "expectedRevision"], deltaPath);
        ensureString(delta.entryId, `${deltaPath}.entryId`, MAX_IDENTIFIER_BYTES);
        const operation = ensureEnum(delta.operation, ["activate", "deactivate", "set_cooldown"] as const, `${deltaPath}.operation`);
        const state = ensureEnum(delta.state, ["active", "inactive", "cooldown"] as const, `${deltaPath}.state`);
        const afterState = ensureObject(delta.afterState, `${deltaPath}.afterState`);
        rejectUnknownKeys(afterState, ["active", "stickyLeft", "cooldownLeft", "delayCount"], `${deltaPath}.afterState`);
        const active = ensureBoolean(afterState.active, `${deltaPath}.afterState.active`);
        const cooldownLeft = ensureSafeInteger(
          afterState.cooldownLeft,
          `${deltaPath}.afterState.cooldownLeft`,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        for (const key of ["stickyLeft", "delayCount"] as const) {
          ensureSafeInteger(afterState[key], `${deltaPath}.afterState.${key}`, 0, Number.MAX_SAFE_INTEGER);
        }
        if (
          (operation === "activate" && (state !== "active" || !active))
          || (operation === "deactivate" && (state !== "inactive" || active))
          || (operation === "set_cooldown" && (state !== "cooldown" || active))
        ) {
          fail("world-info operation/state mismatch", `${deltaPath}.operation`);
        }
        if (delta.expectedRevision !== undefined) validateRevisionValue(delta.expectedRevision, `${deltaPath}.expectedRevision`);
        break;
      case "source_message":
        rejectUnknownKeys(delta, ["kind", "sourceMessageId", "operation", "role", "content", "swipeId", "expectedRevision"], deltaPath);
        ensureString(delta.sourceMessageId, `${deltaPath}.sourceMessageId`, MAX_IDENTIFIER_BYTES);
        ensureEnum(delta.operation, ["create", "update", "delete"] as const, `${deltaPath}.operation`);
        if (delta.role !== undefined) ensureEnum(delta.role, SOURCE_MESSAGE_ROLES, `${deltaPath}.role`);
        if (delta.content !== undefined) stringBytes(delta.content, `${deltaPath}.content`, limits.maxOutputBytes);
        if (delta.swipeId !== undefined) ensureSafeInteger(delta.swipeId, `${deltaPath}.swipeId`, 0, Number.MAX_SAFE_INTEGER);
        if (delta.expectedRevision !== undefined) validateRevisionValue(delta.expectedRevision, `${deltaPath}.expectedRevision`);
        break;
      case "chat_metadata":
        rejectUnknownKeys(delta, ["kind", "key", "operation", "value", "expectedRevision"], deltaPath);
        ensureString(delta.key, `${deltaPath}.key`, MAX_VARIABLE_KEY_BYTES);
        ensureEnum(delta.operation, ["set", "delete"] as const, `${deltaPath}.operation`);
        if (delta.value !== undefined && delta.value !== null && !["string", "number", "boolean"].includes(typeof delta.value)) {
          fail("invalid chat metadata value", `${deltaPath}.value`);
        }
        if (typeof delta.value === "string") stringBytes(delta.value, `${deltaPath}.value`, limits.maxOutputBytes);
        if (typeof delta.value === "number" && !Number.isFinite(delta.value)) fail("invalid chat metadata number", `${deltaPath}.value`);
        if (delta.expectedRevision !== undefined) validateRevisionValue(delta.expectedRevision, `${deltaPath}.expectedRevision`);
        break;
      case "regex_action":
        rejectUnknownKeys(delta, ["kind", "scriptId", "operation", "expectedRevision"], deltaPath);
        ensureString(delta.scriptId, `${deltaPath}.scriptId`, MAX_IDENTIFIER_BYTES);
        ensureEnum(delta.operation, ["apply", "skip", "disable"] as const, `${deltaPath}.operation`);
        if (delta.expectedRevision !== undefined) validateRevisionValue(delta.expectedRevision, `${deltaPath}.expectedRevision`);
        break;
      default:
        fail("unknown preparation delta kind", `${deltaPath}.kind`);
    }
  }
}

/** Exact textual size of one validated render content value. */
export function renderContentByteSizeV1(content: RenderContentV1): number {
  if (content.kind === "text") return content.text === undefined ? 0 : utf8ByteLength(content.text);
  let bytes = 0;
  for (const part of content.parts ?? []) {
    if (part.kind === "text") {
      bytes += utf8ByteLength(part.text);
      continue;
    }
    bytes += utf8ByteLength(part.mediaKind)
      + utf8ByteLength(part.mimeType)
      + utf8ByteLength(part.reference)
      + (part.altText === undefined ? 0 : utf8ByteLength(part.altText));
  }
  return bytes;
}

function revisionBytes(value: number | string | undefined): number {
  if (value === undefined) return 0;
  return typeof value === "string" ? utf8ByteLength(value) : utf8ByteLength(String(value));
}

function macroSnapshotBytes(snapshot: RenderMacroSnapshotV1): number {
  let bytes = 0;
  for (const group of MACRO_SNAPSHOT_GROUPS) {
    for (const [key, value] of snapshot[group]) {
      bytes += utf8ByteLength(key) + utf8ByteLength(value);
    }
  }
  for (const dependency of snapshot.dependencies ?? []) {
    bytes += utf8ByteLength(dependency.name)
      + utf8ByteLength(dependency.purity)
      + utf8ByteLength(dependency.source);
  }
  return bytes;
}

function regexScriptBytes(script: FrozenRegexScriptV1): number {
  let bytes = utf8ByteLength(script.scriptId)
    + revisionBytes(script.revision)
    + utf8ByteLength(script.pattern)
    + utf8ByteLength(script.replacement)
    + utf8ByteLength(script.flags)
    + utf8ByteLength(script.stage);
  for (const trim of script.trimStrings ?? []) bytes += utf8ByteLength(trim);
  for (const action of script.actions ?? []) {
    bytes += utf8ByteLength(action.id) + utf8ByteLength(action.type);
  }
  return bytes;
}

function revisionSetBytes(set: InputRevisionSetV1): number {
  let bytes = utf8ByteLength(set.digest);
  for (const revision of set.revisions) {
    bytes += utf8ByteLength(revision.kind)
      + utf8ByteLength(revision.id)
      + revisionBytes(revision.revision)
      + utf8ByteLength(revision.digest);
  }
  return bytes;
}

function deltaBytes(delta: PreparationDeltaV1): number {
  let bytes = utf8ByteLength(delta.kind) + utf8ByteLength(delta.operation);
  switch (delta.kind) {
    case "macro_variable":
      bytes += utf8ByteLength(delta.scope)
        + utf8ByteLength(delta.key)
        + (delta.value === undefined ? 0 : utf8ByteLength(delta.value));
      break;
    case "world_info_state":
      bytes += utf8ByteLength(delta.entryId) + utf8ByteLength(delta.state)
        + 1
        + 8 * 3;
      break;
    case "source_message":
      bytes += utf8ByteLength(delta.sourceMessageId)
        + (delta.role === undefined ? 0 : utf8ByteLength(delta.role))
        + (delta.content === undefined ? 0 : utf8ByteLength(delta.content))
        + (delta.swipeId === undefined ? 0 : utf8ByteLength(String(delta.swipeId)));
      break;
    case "chat_metadata":
      bytes += utf8ByteLength(delta.key)
        + (typeof delta.value === "string" ? utf8ByteLength(delta.value) : 0);
      break;
    case "regex_action":
      bytes += utf8ByteLength(delta.scriptId);
      break;
  }
  return bytes + revisionBytes(delta.expectedRevision);
}

/**
 * Exact aggregate textual size of a validated strict render input.
 *
 * Every textual field the isolate can read is counted once: identity, target,
 * render content, retained reasoning, source messages, swipes, the macro
 * snapshot, every regex pattern/replacement/flag/trim/action field, authored
 * formatting delimiters, the frozen revision set, and every deferred delta.
 * Derived revision-set projections alias already-counted entries and are not
 * double counted.
 */
export function aggregateRenderInputBytesV1(
  input: RenderPreparationInputV1,
  limits: PreparationLimitsV1,
): number {
  const target = input.target;
  let bytes = utf8ByteLength(input.requestId)
    + utf8ByteLength(input.turnId)
    + utf8ByteLength(target.kind)
    + revisionBytes(target.messageId)
    + revisionBytes(target.swipeId)
    + (target.branchId === undefined ? 0 : utf8ByteLength(target.branchId))
    + renderContentByteSizeV1(input.content)
    + (input.reasoning === undefined ? 0 : utf8ByteLength(input.reasoning))
    + macroSnapshotBytes(input.macroSnapshot)
    + revisionSetBytes(input.inputRevisions);
  const delimiters = input.formatting.reasoningDelimiters;
  if (delimiters !== undefined) {
    bytes += utf8ByteLength(delimiters.prefix) + utf8ByteLength(delimiters.suffix);
  }
  for (const message of input.sourceMessages) {
    bytes += utf8ByteLength(message.sourceMessageId)
      + utf8ByteLength(message.role)
      + revisionBytes(message.revision)
      + (message.swipeId === undefined ? 0 : utf8ByteLength(String(message.swipeId)))
      + renderContentByteSizeV1(message.content)
      + (message.authorName === undefined ? 0 : utf8ByteLength(message.authorName));
  }
  for (const swipe of input.swipes) {
    bytes += utf8ByteLength(swipe.swipeId)
      + revisionBytes(swipe.revision)
      + (swipe.slot === undefined ? 0 : utf8ByteLength(swipe.slot))
      + renderContentByteSizeV1(swipe.content);
  }
  for (const script of input.regexScripts) bytes += regexScriptBytes(script);
  for (const delta of input.deltas) bytes += deltaBytes(delta);
  if (bytes > limits.maxInputBytes) {
    limitExceeded("aggregate textual input exceeds the limit", "input");
  }
  return bytes;
}

const INPUT_LIMIT_NAMES = [
  "maxInputBytes",
  "maxOutputBytes",
  "maxCumulativeExpansionBytes",
  "maxOperationBytes",
  "maxPromptBlocks",
  "maxActiveScripts",
  "maxCompiledPatterns",
  "maxMacroResolutions",
  "maxTrimStrings",
  "maxCooperativeCpuMs",
  "maxWallClockMs",
  "maxWorkers",
  "maxQueuedJobsPerUser",
  "maxQueuedJobsProcess",
] as const;

export interface ValidatedRenderPreparationRequestV1 {
  readonly input: RenderPreparationInputV1;
  readonly limits: PreparationLimitsV1;
  readonly inputBytes: number;
}

/**
 * Validate the closed worker input before any transformation or allocation and
 * return its effective limits plus exact aggregate textual size.
 */
export function validateRenderPreparationRequestV1(
  value: unknown,
  requestedLimits?: PreparationLimitsV1,
): ValidatedRenderPreparationRequestV1 {
  validateClosedPlainData(value, "input");
  const input = ensureObject(
    cloneClosedData(value, "input", HOST_PREPARATION_LIMITS_V1.maxInputBytes + HOST_PREPARATION_LIMITS_V1.maxOutputBytes),
    "input",
  );
  rejectUnknownKeys(input, [
    "version",
    "operation",
    "requestId",
    "limits",
    "turnId",
    "target",
    "content",
    "reasoning",
    "sourceMessages",
    "swipes",
    "macroSnapshot",
    "regexScripts",
    "formatting",
    "inputRevisions",
    "deltas",
  ], "input");
  const inputLimits = ensureObject(input.limits, "limits");
  rejectUnknownKeys(inputLimits, INPUT_LIMIT_NAMES, "limits");
  for (const key of INPUT_LIMIT_NAMES) ensureSafeInteger(inputLimits[key], `limits.${key}`, 0, Number.MAX_SAFE_INTEGER);
  const limits = lowerPreparationLimitsV1(requestedLimits ?? (input.limits as PreparationLimitsV1));
  ensureVersion(input.version, "version");
  ensureOperation(input.operation, "operation");
  ensureString(input.requestId, "requestId", MAX_IDENTIFIER_BYTES);
  ensureString(input.turnId, "turnId", MAX_IDENTIFIER_BYTES);
  validateTarget(input.target);
  renderContentBytes(input.content, "content", limits, limits.maxInputBytes);
  if (input.reasoning !== undefined) stringBytes(input.reasoning, "reasoning", limits.maxInputBytes);
  validateSourceMessages(input.sourceMessages, limits);
  validateSwipes(input.swipes, limits);
  validateMacroSnapshot(input.macroSnapshot, limits);
  validateRegexScripts(input.regexScripts, limits);
  validateRevisionSet(input.inputRevisions, "inputRevisions");
  validateDeltas(input.deltas, limits, "deltas");
  validateFormatting(input.formatting, limits);
  const typed = input as unknown as RenderPreparationInputV1;
  return { input: typed, limits, inputBytes: aggregateRenderInputBytesV1(typed, limits) };
}

/** Validate the closed worker input before any transformation or allocation. */
export function validateRenderPreparationInputV1(
  value: unknown,
  requestedLimits?: PreparationLimitsV1,
): RenderPreparationInputV1 {
  return validateRenderPreparationRequestV1(value, requestedLimits).input;
}

export function validateRenderPreparationResultV1(
  value: unknown,
  limits: PreparationLimitsV1 = HOST_PREPARATION_LIMITS_V1,
): RenderPreparationResultV1 {
  const resultMaxBytes = HOST_PREPARATION_LIMITS_V1.maxInputBytes + HOST_PREPARATION_LIMITS_V1.maxOutputBytes;
  validateClosedPlainData(value, "result", resultMaxBytes);
  const result = ensureObject(cloneClosedData(value, "result", resultMaxBytes), "result");
  rejectUnknownKeys(result, [
    "version",
    "operation",
    "requestId",
    "content",
    "reasoning",
    "usage",
    "macroVariableDeltas",
    "sourceMessageDeltas",
    "chatMetadataDeltas",
    "regexActionDeltas",
    "worldInfoStateDeltas",
    "inputRevisions",
  ], "result");
  ensureVersion(result.version, "result.version");
  ensureOperation(result.operation, "result.operation");
  ensureString(result.requestId, "result.requestId", MAX_IDENTIFIER_BYTES);
  const outputBytes = renderContentBytes(result.content, "result.content", limits, limits.maxOutputBytes);
  assertRenderOutputBytesWithinLimit(outputBytes, limits);
  if (result.reasoning !== undefined) fail("strict render result must not retain reasoning", "result.reasoning");
  const usage = ensureObject(result.usage, "result.usage");
  rejectUnknownKeys(usage, ["promptTokens", "completionTokens", "totalTokens"], "result.usage");
  let sourceDeltaBytes = 0;
  for (const key of ["macroVariableDeltas", "sourceMessageDeltas", "chatMetadataDeltas", "regexActionDeltas", "worldInfoStateDeltas"] as const) {
    validateDeltas(result[key], limits, `result.${key}`);
    if (key === "sourceMessageDeltas") {
      for (const delta of result[key] as readonly PreparationDeltaV1[]) sourceDeltaBytes += deltaBytes(delta);
    }
  }
  if (sourceDeltaBytes > limits.maxOutputBytes) {
    limitExceeded("source-message deltas exceed the output limit", "result.sourceMessageDeltas");
  }
  validateRevisionSet(result.inputRevisions, "result.inputRevisions");
  return result as unknown as RenderPreparationResultV1;
}

export function assertRenderOutputBytesWithinLimit(bytes: number, limits: PreparationLimitsV1): void {
  if (bytes > limits.maxOutputBytes) {
    limitExceeded("render output exceeds the limit", "content");
  }
}

export function assertRenderOutputWithinLimit(content: string, limits: PreparationLimitsV1): void {
  assertRenderOutputBytesWithinLimit(utf8ByteLength(content), limits);
}

export function getEffectiveRenderPreparationLimits(
  requested?: PreparationLimitsV1,
): PreparationLimitsV1 {
  return lowerPreparationLimitsV1(requested ?? HOST_PREPARATION_LIMITS_V1);
}

export { utf8ByteLength };
