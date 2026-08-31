import { healFormattingArtifacts } from "../utils/format-healing";
import type {
  ChatMetadataDeltaV1,
  FrozenRegexScriptV1,
  FrozenSourceMessageV1,
  MacroVariableDeltaV1,
  PreparationDeltaV1,
  PreparationLimitsV1,
  RegexActionDeltaV1,
  RenderContentV1,
  RenderFormattingPolicyV1,
  RenderMacroSnapshotV1,
  RenderPreparationInputV1,
  RenderPreparationResultV1,
  SourceMessageDeltaV1,
  WorldInfoStateDeltaV1,
} from "../types/agent-preprocessing";
import { createExpansionBudget, type ExpansionBudgetV1 } from "../types/agent-preprocessing";
import {
  extractDelimitedReasoningV1,
  resolveReasoningDelimitersV1,
} from "../utils/reasoning-strip-pure";
import {
  assertRenderOutputBytesWithinLimit,
  RenderPreparationValidationError,
  utf8ByteLengthV1,
  validateRenderPreparationRequestV1,
  validateRenderPreparationResultV1,
} from "./agentic-render-preparation-validator";
import {
  cloneCanonicalPlainData,
  freezeCanonicalPlainData,
} from "../utils/canonical-plain-data";

type Dict = Record<string, unknown>;

type RenderPreparationOptions = {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly now?: () => number;
  readonly limits?: PreparationLimitsV1;
};

type MacroScope = "local" | "global" | "chat";

type MacroDelta = MacroVariableDeltaV1;

type MacroState = {
  readonly values: Record<MacroScope, Map<string, string>>;
  readonly deltas: MacroDelta[];
};

const NON_PURE_MACRO_NAMES: Record<string, true> = {
  databank: true,
  databankactive: true,
  databankcount: true,
  documents: true,
  knowledgebank: true,
  memories: true,
  memoriesraw: true,
  memory: true,
  lore: true,
  worldinfo: true,
  world: true,
  context: true,
  retrieval: true,
  random: true,
  rand: true,
  roll: true,
  date: true,
  time: true,
  now: true,
  eval: true,
  evalm: true,
};



function contentText(content: RenderContentV1): string {
  if (content.kind === "text") return content.text ?? "";
  return (content.parts ?? [])
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function contentWithText(content: RenderContentV1, text: string): RenderContentV1 {
  if (content.kind === "text") return Object.freeze({ kind: "text", text });
  const parts = (content.parts ?? []).map((part) => ({ ...part }));
  let replaced = false;
  const nextParts = parts.map((part) => {
    if (part.kind !== "text") return part;
    if (replaced) return { ...part, text: "" } as const;
    replaced = true;
    return { ...part, text } as const;
  });
  if (!replaced) nextParts.unshift({ kind: "text", text });
  return Object.freeze({ kind: "parts", parts: nextParts });
}

/** Exact UTF-8 size of `value[start, end)` without allocating the substring. */
function utf8ByteLengthRange(value: string, start: number, end: number): number {
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A complete surrogate pair is one 4-byte code point; an unpaired
        // surrogate encodes as U+FFFD, exactly like Buffer.byteLength.
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

function stringMap(entries: readonly [string, string][]): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of entries) result.set(key, value);
  return result;
}

function macroState(snapshot: RenderPreparationInputV1["macroSnapshot"]): MacroState {
  return {
    values: {
      local: stringMap(snapshot.local),
      global: stringMap([...snapshot.global, ...snapshot.promptVariables]),
      chat: stringMap(snapshot.chat),
    },
    deltas: [],
  };
}
/**
 * Only `pure` host/preset macro dependencies may execute here. Anything the
 * compiler marked non-pure, extension-owned, or callback-backed fails preflight
 * so the turn falls back to Response mode instead of reaching a host callback.
 */
function assertFrozenMacroMetadataIsPure(snapshot: RenderMacroSnapshotV1): void {
  for (const dependency of snapshot.dependencies ?? []) {
    if (dependency.purity === "pure" && (dependency.source === "host" || dependency.source === "preset")) continue;
    throw new RenderPreparationValidationError(
      "requires_response_mode",
      `authored macro dependency ${dependency.name} is not pure`,
      "macroSnapshot",
    );
  }
}

function inputDeltaMatches(
  deltas: readonly PreparationDeltaV1[],
  predicate: (delta: PreparationDeltaV1) => boolean,
): boolean {
  return deltas.some(predicate);
}

function assertVariableDeltaAuthorized(
  state: MacroState,
  inputDeltas: readonly PreparationDeltaV1[],
  scope: MacroScope,
  key: string,
  operation: "set" | "delete",
): void {
  const authorized = inputDeltaMatches(inputDeltas, (delta) => (
    delta.kind === "macro_variable"
    && delta.scope === scope
    && delta.key === key
    && delta.operation === operation
  ));
  if (!authorized) {
    throw new RenderPreparationValidationError(
      "requires_response_mode",
      `macro variable delta is not authorized for ${scope}:${key}`,
      `macro.${scope}.${key}`,
    );
  }
  if (state.deltas.some((delta) => delta.scope === scope && delta.key === key && delta.operation === operation)) return;
}
function variableExpectedRevision(
  inputDeltas: readonly PreparationDeltaV1[],
  scope: MacroScope,
  key: string,
  operation: "set" | "delete",
): number | string | undefined {
  return inputDeltas.find((delta) => (
    delta.kind === "macro_variable"
    && delta.scope === scope
    && delta.key === key
    && delta.operation === operation
  ))?.expectedRevision;
}

function setVariable(
  state: MacroState,
  inputDeltas: readonly PreparationDeltaV1[],
  scope: MacroScope,
  key: string,
  value: string,
): void {
  assertVariableDeltaAuthorized(state, inputDeltas, scope, key, "set");
  state.values[scope].set(key, value);
  const expectedRevision = variableExpectedRevision(inputDeltas, scope, key, "set");
  state.deltas.push({
    kind: "macro_variable",
    scope,
    key,
    operation: "set",
    value,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

function deleteVariable(
  state: MacroState,
  inputDeltas: readonly PreparationDeltaV1[],
  scope: MacroScope,
  key: string,
): void {
  assertVariableDeltaAuthorized(state, inputDeltas, scope, key, "delete");
  state.values[scope].delete(key);
  const expectedRevision = variableExpectedRevision(inputDeltas, scope, key, "delete");
  state.deltas.push({
    kind: "macro_variable",
    scope,
    key,
    operation: "delete",
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}
function readVariable(state: MacroState, scope: MacroScope, key: string): string {
  return state.values[scope].get(key) ?? "";
}

function splitMacroBody(body: string): string[] {
  return body.split("::");
}

function findMacroEnd(value: string, start: number): number {
  let depth = 0;
  for (let index = start; index < value.length - 1; index += 1) {
    if (value[index] === "{" && value[index + 1] === "{") {
      depth += 1;
      index += 1;
    } else if (value[index] === "}" && value[index + 1] === "}") {
      depth -= 1;
      index += 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function macroName(body: string): string {
  return body.trim().split("::", 1)[0]!.toLowerCase();
}

function directMacroValue(state: MacroState, name: string): string | undefined {
  for (const scope of ["local", "global", "chat"] as const) {
    for (const [key, value] of state.values[scope]) {
      if (key.toLowerCase() === name) return value;
    }
  }
  return undefined;
}

function resolveMacroVariable(
  bodyParts: string[],
  state: MacroState,
  inputDeltas: readonly PreparationDeltaV1[],
): { handled: boolean; value: string } {
  const name = bodyParts[0]!.toLowerCase();
  const readScopes: Record<string, MacroScope> = {
    var: "local",
    getvar: "local",
    localvar: "local",
    promptvar: "global",
    presetvar: "global",
    globalvar: "global",
    chatvar: "chat",
    getchatvar: "chat",
  };
  const scope = readScopes[name];
  if (scope) {
    const key = bodyParts[1]?.trim();
    return key ? { handled: true, value: readVariable(state, scope, key) } : { handled: false, value: "" };
  }
  const key = bodyParts[1]?.trim();
  if (!key || !["setvar", "setchatvar", "deletevar"].includes(name)) return { handled: false, value: "" };
  const writeScope: MacroScope = name === "setchatvar" ? "chat" : "local";
  if (name === "deletevar") {
    deleteVariable(state, inputDeltas, writeScope, key);
    return { handled: true, value: "" };
  }
  const value = bodyParts.slice(2).join("::");
  setVariable(state, inputDeltas, writeScope, key, value);
  return { handled: true, value };
}

function resolvePureMacroText(
  input: string,
  state: MacroState,
  inputDeltas: readonly PreparationDeltaV1[],
  budget: RenderPreparationBudget,
  depth = 0,
): string {
  if (!input.includes("{{")) return input;
  if (depth > 64) {
    throw new RenderPreparationValidationError("limit_exceeded", "macro nesting exceeds the limit", "macro");
  }
  let result = "";
  let resultBytes = 0;
  let cursor = 0;
  while (cursor < input.length) {
    budget.check();
    const start = input.indexOf("{{", cursor);
    if (start < 0) {
      resultBytes = budget.appendBytes(resultBytes, utf8ByteLengthRange(input, cursor, input.length), "macro");
      result += input.slice(cursor);
      break;
    }
    resultBytes = budget.appendBytes(resultBytes, utf8ByteLengthRange(input, cursor, start), "macro");
    result += input.slice(cursor, start);
    const end = findMacroEnd(input, start);
    if (end < 0) {
      resultBytes = budget.appendBytes(resultBytes, utf8ByteLengthRange(input, start, input.length), "macro");
      result += input.slice(start);
      break;
    }
    const body = input.slice(start + 2, end - 2);
    const parts = splitMacroBody(body);
    const name = macroName(body);
    budget.reserveMacroResolution();
    const args = parts.slice(1).map((part) => resolvePureMacroText(part, state, inputDeltas, budget, depth + 1));
    const variable = resolveMacroVariable([parts[0]!, ...args], state, inputDeltas);
    let replacement: string;
    let countsExpansion = true;
    if (variable.handled) {
      replacement = variable.value;
    } else if (NON_PURE_MACRO_NAMES[name]) {
      throw new RenderPreparationValidationError("requires_response_mode", `macro ${name} is not pure`, `macro.${name}`);
    } else {
      const direct = directMacroValue(state, name);
      replacement = direct ?? input.slice(start, end);
      countsExpansion = direct !== undefined;
    }
    const replacementBytes = utf8ByteLengthV1(replacement);
    if (countsExpansion) budget.commitGenerated(replacementBytes, `macro.${name}`);
    resultBytes = budget.appendBytes(resultBytes, replacementBytes, `macro.${name}`);
    result += replacement;
    cursor = end;
  }
  return result;
}

class RenderPreparationBudget {
  readonly limits: PreparationLimitsV1;
  readonly expansionBudget: ExpansionBudgetV1;
  private readonly options: RenderPreparationOptions;
  private readonly startedAt: number;

  constructor(limits: PreparationLimitsV1, options: RenderPreparationOptions) {
    this.limits = limits;
    this.options = options;
    this.expansionBudget = createExpansionBudget(limits, options.signal);
    this.startedAt = (options.now ?? Date.now)();
  }

  check(): void {
    if (this.options.signal?.aborted) {
      throw new RenderPreparationValidationError("cancelled", "render preparation was cancelled");
    }
    const now = this.clock();
    if (this.options.deadlineAt !== undefined && now >= this.options.deadlineAt) {
      throw new RenderPreparationValidationError("worker_timed_out", "render preparation deadline exceeded");
    }
    if (now - this.startedAt > this.limits.maxCooperativeCpuMs || now - this.startedAt > this.limits.maxWallClockMs) {
      throw new RenderPreparationValidationError("worker_timed_out", "render preparation deadline exceeded");
    }
    try {
      this.expansionBudget.checkAbort();
    } catch {
      throw new RenderPreparationValidationError("cancelled", "render preparation was cancelled");
    }
  }

  reserveInput(bytes: number): void {
    this.check();
    try {
      this.expansionBudget.reserveInput(bytes);
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", "aggregate textual input exceeds the limit", "input");
    }
  }

  reserveMacroResolution(): void {
    this.check();
    try {
      this.expansionBudget.reserveMacroResolutions();
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", "macro resolutions exceed the limit", "macro");
    }
  }

  reserveTrimString(path: string): void {
    this.check();
    try {
      this.expansionBudget.reserveTrimString();
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", "trim strings exceed the limit", path);
    }
  }

  /**
   * Check the exact prospective size of a fragment this operation is about to
   * generate. Nothing is allocated and nothing is charged until it succeeds.
   */
  preflightGenerated(bytes: number, path: string): void {
    this.check();
    try {
      this.expansionBudget.preflightExpansion(bytes, bytes);
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", `${path} exceeds preparation limits`, path);
    }
  }

  /** Charge a generated fragment's exact bytes once it has been produced. */
  commitGenerated(bytes: number, path: string): void {
    this.check();
    try {
      this.expansionBudget.accountExpansion(bytes, bytes);
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", `${path} exceeds preparation limits`, path);
    }
  }

  /**
   * Check a whole-content transform against the per-operation ceiling using a
   * proven upper bound on its output, before that output is allocated. Only
   * real growth is charged to the cumulative expansion budget.
   */
  preflightTransform(upperBoundBytes: number, consumedBytes: number, path: string): void {
    this.check();
    try {
      this.expansionBudget.preflightExpansion(Math.max(0, upperBoundBytes - consumedBytes), upperBoundBytes);
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", `${path} exceeds preparation limits`, path);
    }
  }

  /** Charge a completed transform's exact produced size and real growth. */
  commitTransform(producedBytes: number, consumedBytes: number, path: string): void {
    this.check();
    try {
      this.expansionBudget.accountExpansion(Math.max(0, producedBytes - consumedBytes), producedBytes);
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", `${path} exceeds preparation limits`, path);
    }
  }

  /** Bound an intermediate or final content size against the output ceiling. */
  noteContentBytes(bytes: number, path: string): void {
    this.check();
    try {
      this.expansionBudget.noteOutput(bytes);
    } catch {
      throw new RenderPreparationValidationError("limit_exceeded", `${path} exceeds preparation limits`, path);
    }
  }

  /**
   * Bound a growing buffer before the append happens and return its new size,
   * so no intermediate string can reach the output ceiling plus one byte.
   */
  appendBytes(currentBytes: number, addedBytes: number, path: string): number {
    const next = currentBytes + addedBytes;
    this.noteContentBytes(next, path);
    return next;
  }

  get expansion(): number {
    return this.expansionBudget.cumulativeExpansionBytes;
  }

  private clock(): number {
    return (this.options.now ?? Date.now)();
  }
}

type ReplacementToken =
  | { readonly kind: "literal"; readonly text: string; readonly bytes: number }
  | { readonly kind: "match" }
  | { readonly kind: "before" }
  | { readonly kind: "after" }
  | { readonly kind: "capture"; readonly index: number; readonly token: string; readonly tokenBytes: number }
  | { readonly kind: "named"; readonly name: string; readonly token: string; readonly tokenBytes: number };

const REPLACEMENT_TOKEN_RE = /\$(?:(\$)|(&)|(`)|(')|(\d{1,2})|<([^>]*)>)/g;

/**
 * Compile a resolved replacement template once so each match can be measured
 * exactly before it is built. `$\`` and `$'` copy the entire text around a
 * match, so measuring after construction would allocate first and check later.
 */
function compileReplacementTemplate(template: string): readonly ReplacementToken[] {
  const tokens: ReplacementToken[] = [];
  let cursor = 0;
  const pushLiteral = (text: string): void => {
    if (text.length > 0) tokens.push({ kind: "literal", text, bytes: utf8ByteLengthV1(text) });
  };
  for (const match of template.matchAll(REPLACEMENT_TOKEN_RE)) {
    const index = match.index ?? 0;
    pushLiteral(template.slice(cursor, index));
    const token = match[0];
    if (match[1] !== undefined) tokens.push({ kind: "literal", text: "$", bytes: 1 });
    else if (match[2] !== undefined) tokens.push({ kind: "match" });
    else if (match[3] !== undefined) tokens.push({ kind: "before" });
    else if (match[4] !== undefined) tokens.push({ kind: "after" });
    else if (match[5] !== undefined) {
      tokens.push({ kind: "capture", index: Number(match[5]), token, tokenBytes: utf8ByteLengthV1(token) });
    } else {
      tokens.push({ kind: "named", name: match[6] ?? "", token, tokenBytes: utf8ByteLengthV1(token) });
    }
    cursor = index + token.length;
  }
  pushLiteral(template.slice(cursor));
  return tokens;
}

/** Exact substitution for one token; identical to the size accounting below. */
function replacementTokenValue(token: ReplacementToken, match: RegExpExecArray, input: string): string {
  switch (token.kind) {
    case "literal":
      return token.text;
    case "match":
      return match[0];
    case "before":
      return input.slice(0, match.index);
    case "after":
      return input.slice(match.index + match[0].length);
    case "capture":
      return token.index > 0 && token.index < match.length ? match[token.index] ?? "" : token.token;
    case "named":
      return match.groups ? match.groups[token.name] ?? token.token : token.token;
  }
}

function replacementBytesForMatch(
  tokens: readonly ReplacementToken[],
  match: RegExpExecArray,
  beforeBytes: number,
  matchBytes: number,
  afterBytes: number,
): number {
  let bytes = 0;
  for (const token of tokens) {
    switch (token.kind) {
      case "literal":
        bytes += token.bytes;
        break;
      case "match":
        bytes += matchBytes;
        break;
      case "before":
        bytes += beforeBytes;
        break;
      case "after":
        bytes += afterBytes;
        break;
      case "capture":
        bytes += token.index > 0 && token.index < match.length
          ? utf8ByteLengthV1(match[token.index] ?? "")
          : token.tokenBytes;
        break;
      case "named": {
        const value = match.groups ? match.groups[token.name] : undefined;
        bytes += value === undefined ? token.tokenBytes : utf8ByteLengthV1(value);
        break;
      }
    }
  }
  return bytes;
}

function applyResponseRegex(
  input: string,
  script: FrozenRegexScriptV1,
  budget: RenderPreparationBudget,
  state: MacroState,
  inputDeltas: readonly PreparationDeltaV1[],
): string {
  // A disabled script performs no transformation in either mode, so its
  // authored actions cannot leak; only an executing script is refused.
  if (!script.enabled) return input;
  if (script.actions !== undefined && script.actions.length > 0) {
    throw new RenderPreparationValidationError(
      "requires_response_mode",
      `regex script ${script.scriptId} declares interactive actions`,
      `regex.${script.scriptId}.actions`,
    );
  }
  const path = `regex.${script.scriptId}`;
  const regex = new RegExp(script.pattern, script.flags);
  const totalBytes = utf8ByteLengthV1(input);
  let tokens: readonly ReplacementToken[] | undefined;
  const pieces: string[] = [];
  let cursor = 0;
  let matchCount = 0;
  // Exact bytes of `input[0, cursor)`; each match advances it over a disjoint
  // range, so the whole scan stays linear in the input size.
  let consumedBytes = 0;
  let producedBytes = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    budget.check();
    matchCount += 1;
    if (matchCount > budget.limits.maxCompiledPatterns) {
      throw new RenderPreparationValidationError("limit_exceeded", "regex matches exceed the limit", path);
    }
    tokens ??= compileReplacementTemplate(resolvePureMacroText(script.replacement, state, inputDeltas, budget));
    const prefixBytes = utf8ByteLengthRange(input, cursor, match.index);
    const matchStartBytes = consumedBytes + prefixBytes;
    const matchBytes = utf8ByteLengthRange(input, match.index, match.index + match[0].length);
    const replacementBytes = replacementBytesForMatch(
      tokens,
      match,
      matchStartBytes,
      matchBytes,
      totalBytes - matchStartBytes - matchBytes,
    );
    budget.preflightGenerated(replacementBytes, `${path}.replacement`);
    budget.noteContentBytes(producedBytes + prefixBytes + replacementBytes, path);
    let replacement = "";
    for (const token of tokens) replacement += replacementTokenValue(token, match, input);
    budget.commitGenerated(replacementBytes, `${path}.replacement`);
    pieces.push(input.slice(cursor, match.index), replacement);
    producedBytes += prefixBytes + replacementBytes;
    consumedBytes = matchStartBytes + matchBytes;
    cursor = match.index + match[0].length;
    if (!regex.global && !regex.sticky) break;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (matchCount === 0) return applyTrimStrings(input, script, budget);
  budget.noteContentBytes(producedBytes + (totalBytes - consumedBytes), path);
  pieces.push(input.slice(cursor));
  return applyTrimStrings(pieces.join(""), script, budget);
}

/** Literal trims only ever shrink their input, so they need no growth budget. */
function applyTrimStrings(
  value: string,
  script: FrozenRegexScriptV1,
  budget: RenderPreparationBudget,
): string {
  const trims = script.trimStrings;
  if (trims === undefined || trims.length === 0) return value;
  const path = `regex.${script.scriptId}.trim`;
  let result = value;
  for (const trim of trims) {
    budget.check();
    if (trim.length === 0) {
      throw new RenderPreparationValidationError("invalid_input", "regex trim strings must be non-empty", path);
    }
    budget.reserveTrimString(path);
    result = result.replaceAll(trim, "");
  }
  budget.noteContentBytes(utf8ByteLengthV1(result), path);
  return result;
}

function sortResponseScripts(scripts: readonly FrozenRegexScriptV1[]): FrozenRegexScriptV1[] {
  return [...scripts].sort((left, right) => left.order - right.order || left.scriptId.localeCompare(right.scriptId));
}

function authorizedRegexAction(
  script: FrozenRegexScriptV1,
  inputDeltas: readonly PreparationDeltaV1[],
): RegexActionDeltaV1 | undefined {
  const authorized = inputDeltaMatches(inputDeltas, (delta) => delta.kind === "regex_action" && delta.scriptId === script.scriptId);
  if (!authorized) return undefined;
  const expectedRevision = inputDeltas.find((delta) => delta.kind === "regex_action" && delta.scriptId === script.scriptId)?.expectedRevision ?? script.revision;
  return {
    kind: "regex_action",
    scriptId: script.scriptId,
    operation: script.enabled ? "apply" : "skip",
    expectedRevision,
  };
}

function sourceDeltaAuthorization(
  source: FrozenSourceMessageV1,
  inputDeltas: readonly PreparationDeltaV1[],
): SourceMessageDeltaV1 | undefined {
  const candidate = inputDeltas.find((delta): delta is SourceMessageDeltaV1 => (
    delta.kind === "source_message"
    && delta.sourceMessageId === source.sourceMessageId
    && delta.operation === "update"
    && delta.swipeId === source.swipeId
    && delta.expectedRevision !== undefined
    && String(delta.expectedRevision) === String(source.revision)
  ));
  return candidate;
}

function reconcileTarget(
  input: RenderPreparationInputV1,
  content: string,
): ChatMetadataDeltaV1 {
  const target = input.target;
  const targetValue = typeof target.messageId === "number" || typeof target.messageId === "string"
    ? String(target.messageId)
    : "";
  const swipeValue = typeof target.swipeId === "number" || typeof target.swipeId === "string"
    ? String(target.swipeId)
    : "";
  if ((target.kind === "regenerate" || target.kind === "swipe") && (!targetValue || !swipeValue)) {
    throw new RenderPreparationValidationError("invalid_input", "swipe target is incomplete", "target");
  }
  if (target.kind === "continue" && !targetValue) {
    throw new RenderPreparationValidationError("invalid_input", "continue target is incomplete", "target.messageId");
  }
  const swipe = input.swipes.find((candidate) => candidate.swipeId === swipeValue);
  if ((target.kind === "regenerate" || target.kind === "swipe") && !swipe) {
    throw new RenderPreparationValidationError("invalid_input", "target swipe is not in the frozen snapshot", "target.swipeId");
  }
  if (swipe?.slot === "append" && target.kind !== "regenerate" && target.kind !== "swipe") {
    throw new RenderPreparationValidationError("invalid_input", "append swipe slot requires swipe generation", "target.kind");
  }
  const key = target.kind === "normal"
    ? "generated_message"
    : target.kind === "continue"
      ? `message:${targetValue}:continue`
      : `message:${targetValue}:swipe:${swipeValue}`;
  const expectedRevision = swipe?.slot === "append" ? undefined : swipe?.revision;
  return {
    kind: "chat_metadata",
    key,
    operation: "set",
    value: content,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function estimateTokens(bytes: number): number {
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

export function calculateRenderUsage(
  inputBytes: number,
  outputBytes: number,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const promptTokens = estimateTokens(inputBytes);
  const completionTokens = estimateTokens(outputBytes);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}


/**
 * Extraction only removes delimiter blocks and collapses the newline seam they
 * leave behind, so the cleaned text is never larger than its source.
 */
function cleanGuidedReasoning(
  content: string,
  formatting: RenderFormattingPolicyV1,
  budget: RenderPreparationBudget,
): string {
  if (!formatting.stripGuidedReasoning) return content;
  const delimiters = resolveReasoningDelimitersV1(formatting.reasoningDelimiters ?? null);
  const consumedBytes = utf8ByteLengthV1(content);
  budget.preflightTransform(consumedBytes, consumedBytes, "guided_reasoning");
  const cleaned = extractDelimitedReasoningV1(content, delimiters).cleaned;
  if (cleaned === content) return content;
  budget.commitTransform(utf8ByteLengthV1(cleaned), consumedBytes, "guided_reasoning");
  return cleaned;
}

/**
 * Format healing only ever inserts a `</font>` closer (7 bytes) and at most one
 * repaired attribute quote per unterminated `<font …>` token; every other rule
 * preserves or removes bytes. Counting those tokens therefore yields a proven
 * output ceiling that can be checked before the healed string is built.
 */
const FORMAT_HEALING_MAX_INSERTED_BYTES_PER_TAG = 8;

function openFontTagCount(content: string): number {
  let count = 0;
  for (let index = 0; index + 4 < content.length; index += 1) {
    if (content.charCodeAt(index) !== 0x3c) continue;
    if ((content.charCodeAt(index + 1) | 0x20) !== 0x66) continue;
    if ((content.charCodeAt(index + 2) | 0x20) !== 0x6f) continue;
    if ((content.charCodeAt(index + 3) | 0x20) !== 0x6e) continue;
    if ((content.charCodeAt(index + 4) | 0x20) !== 0x74) continue;
    count += 1;
  }
  return count;
}

function healFormatting(content: string, budget: RenderPreparationBudget): string {
  const consumedBytes = utf8ByteLengthV1(content);
  const upperBound = consumedBytes
    + openFontTagCount(content) * FORMAT_HEALING_MAX_INSERTED_BYTES_PER_TAG;
  budget.preflightTransform(upperBound, consumedBytes, "formatting");
  const healed = healFormattingArtifacts(content);
  if (healed === content) return content;
  const producedBytes = utf8ByteLengthV1(healed);
  budget.commitTransform(producedBytes, consumedBytes, "formatting");
  budget.noteContentBytes(producedBytes, "formatting");
  return healed;
}

function preserveWorldInfoDeltas(input: RenderPreparationInputV1): WorldInfoStateDeltaV1[] {
  return input.deltas.filter((delta): delta is WorldInfoStateDeltaV1 => delta.kind === "world_info_state");
}

/**
 * Execute strict prepare_agent_render. No provider, DB, callback registry, or
 * Spindle module is reachable from this import graph.
 */
export function prepareAgentRenderV1(
  value: RenderPreparationInputV1,
  options: RenderPreparationOptions = {},
): RenderPreparationResultV1 {
  const { input, limits, inputBytes } = validateRenderPreparationRequestV1(value, options.limits);
  const budget = new RenderPreparationBudget(limits, options);
  budget.check();
  budget.reserveInput(inputBytes);
  assertFrozenMacroMetadataIsPure(input.macroSnapshot);
  const state = macroState(input.macroSnapshot);
  let content = contentText(input.content);
  budget.noteContentBytes(utf8ByteLengthV1(content), "content");
  content = resolvePureMacroText(content, state, input.deltas, budget);
  budget.check();
  content = cleanGuidedReasoning(content, input.formatting, budget);
  for (const script of sortResponseScripts(input.regexScripts)) {
    content = applyResponseRegex(content, script, budget, state, input.deltas);
  }
  if (input.formatting.healFormatting) content = healFormatting(content, budget);
  const sourceMessageDeltas: SourceMessageDeltaV1[] = [];
  let sourceDeltaBytes = 0;
  for (const source of input.sourceMessages) {
    budget.check();
    const sourceContent = contentText(source.content);
    const resolved = resolvePureMacroText(sourceContent, state, input.deltas, budget);
    if (resolved === sourceContent) continue;
    const authorized = sourceDeltaAuthorization(source, input.deltas);
    if (!authorized) {
      throw new RenderPreparationValidationError(
        "requires_response_mode",
        `source message delta is not authorized for ${source.sourceMessageId}`,
        `sourceMessages.${source.sourceMessageId}`,
      );
    }
    if (sourceMessageDeltas.length >= limits.maxPromptBlocks) {
      throw new RenderPreparationValidationError("limit_exceeded", "source-message delta count exceeds the limit", "sourceMessages");
    }
    const deltaBytes = utf8ByteLengthV1(source.sourceMessageId)
      + utf8ByteLengthV1("update")
      + utf8ByteLengthV1(source.role)
      + utf8ByteLengthV1(resolved)
      + (source.swipeId === undefined ? 0 : utf8ByteLengthV1(String(source.swipeId)))
      + utf8ByteLengthV1(String(authorized.expectedRevision));
    sourceDeltaBytes += deltaBytes;
    if (sourceDeltaBytes > limits.maxOutputBytes) {
      throw new RenderPreparationValidationError("limit_exceeded", "source-message deltas exceed the output limit", "sourceMessages");
    }
    sourceMessageDeltas.push({
      kind: "source_message",
      sourceMessageId: source.sourceMessageId,
      operation: "update",
      role: source.role,
      content: resolved,
      ...(source.swipeId === undefined ? {} : { swipeId: source.swipeId }),
      expectedRevision: authorized.expectedRevision,
    });
  }

  const regexActionDeltas = sortResponseScripts(input.regexScripts)
    .map((script) => authorizedRegexAction(script, input.deltas))
    .filter((delta): delta is RegexActionDeltaV1 => delta !== undefined);
  const outputBytes = utf8ByteLengthV1(content);
  assertRenderOutputBytesWithinLimit(outputBytes, limits);
  const usage = calculateRenderUsage(inputBytes, outputBytes);
  const result = {
    version: 1 as const,
    operation: "prepare_agent_render" as const,
    requestId: input.requestId,
    content: contentWithText(input.content, content),
    usage,
    macroVariableDeltas: cloneCanonicalPlainData(state.deltas),
    sourceMessageDeltas: cloneCanonicalPlainData(sourceMessageDeltas),
    chatMetadataDeltas: [cloneCanonicalPlainData(reconcileTarget(input, content))],
    regexActionDeltas: cloneCanonicalPlainData(regexActionDeltas),
    worldInfoStateDeltas: cloneCanonicalPlainData(preserveWorldInfoDeltas(input)),
    inputRevisions: cloneCanonicalPlainData(input.inputRevisions),
  } as RenderPreparationResultV1;
  const validated = validateRenderPreparationResultV1(result, limits);
  return freezeCanonicalPlainData(validated, {
    maxBytes: limits.maxInputBytes + limits.maxOutputBytes,
  });
}


export type { RenderPreparationOptions };
export { cleanGuidedReasoning, contentText, applyResponseRegex };
