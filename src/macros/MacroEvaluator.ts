import type {
  AstNode,
  TextNode,
  MacroNode,
  ScopedMacroNode,
  MacroEnv,
  MacroExecContext,
  MacroDiagnostic,
  EvaluateResult,
  MacroFlags,
} from "./types";
import { parse, ESCAPED_OPEN, ESCAPED_CLOSE } from "./MacroParser";
import { MacroRegistry } from "./MacroRegistry";
import {
  macroInterceptorChain,
  type MacroInterceptorPhase,
} from "../spindle/macro-interceptor";
import {
  createExpansionBudget,
  HOST_PREPARATION_LIMITS_V1,
  PreparationLimitExceededError,
  type ExpansionBudgetV1,
} from "../types/agent-preprocessing";

const ASYNC_UNWIND_INTERVAL = 64;

// These read-only macros expose preset-owned prompt variables. When an
// extension installs a whole-template interceptor, resolve static reads of a
// declared prompt-variable key before handing the template over. This lets an
// extension consume the resulting value inside its own control structures
// without giving it a chance to reinterpret the read against extension/chat
// state first.
const PROTECTED_PROMPT_READ_NAMES = new Set([
  "var",
  "promptvar",
  "presetvar",
  "hasvar",
  "haspromptvar",
  "haspresetvar",
  "vardefault",
  "promptvardefault",
  "presetvardefault",
  "getvar",
]);

// A prepass must not move a read ahead of a write in the same template. If a
// protected key is mutated anywhere in the template, leave its reads for the
// normal ordered evaluator. This also keeps LumiRealm's stateful scripting
// surface byte-for-byte intact.
const LOCAL_VARIABLE_MUTATION_NAMES = new Set([
  "setvar",
  "addvar",
  "incvar",
  "decvar",
  "deletevar",
  "flushvar",
]);
export interface EvaluateOptions {
  phase?: MacroInterceptorPhase;
  sourceHint?: string;
  sourceOwner?: "host";
  /**
   * Legacy soft work cap on macro resolutions for this call. Breaching it
   * halts evaluation with a diagnostic; breaches of the expansion budget
   * itself reject the whole evaluation.
   */
  maxMacroResolutions?: number;
  /** Shared exact UTF-8 budget. Omitted callers receive the bounded host default. */
  budget?: ExpansionBudgetV1;
}

interface EvaluationState {
  diagnostics: MacroDiagnostic[];
  optionsMacroResolutionsCap?: number;
  activeExpansions: Set<string>;
  halted: boolean;
  sourceOwner?: EvaluateOptions["sourceOwner"];
  budget: ExpansionBudgetV1;
}

const HAS_MACRO_RE = /\{\{|<(?:user|char|bot)>/i;

/**
 * Evaluate a macro template string, resolving all macros using the provided
 * environment and registry.
 *
 * Expansion-budget breaches reject with PreparationLimitExceededError, except
 * construction-scale per-operation overages which skip the offending macro
 * with a diagnostic. Oversized literal input and oversized final output are
 * reported as stable fail-closed results (empty text + diagnostic).
 */
export async function evaluate(
  input: string,
  env: MacroEnv,
  registry: MacroRegistry,
  options?: EvaluateOptions,
): Promise<EvaluateResult> {
  const diagnostics: MacroDiagnostic[] = [];
  const budget = options?.budget ?? env._expansionBudget ?? createExpansionBudget(HOST_PREPARATION_LIMITS_V1, env.signal);

  try {
    // Input bytes cover the authored template. Output bytes are enforced by
    // built-in preflights plus the closing noteOutput; macro source syntax
    // can be larger than the final text and must not consume the output
    // ceiling.
    budget.reserveInput(input);
  } catch (err) {
    if (err instanceof PreparationLimitExceededError) {
      diagnostics.push({ level: "error", message: err.message, code: "limit_exceeded" });
      return { text: "", diagnostics, touchedVars: EMPTY_TOUCHED_VARS, cacheable: true };
    }
    throw err;
  }

  if (!input) return { text: "", diagnostics, touchedVars: EMPTY_TOUCHED_VARS, cacheable: true };

  // Fast-path: skip the entire lex/parse/evaluate pipeline when there are
  // no macro markers in the input (the vast majority of stored chat messages).
  if (!HAS_MACRO_RE.test(input)) {
    try {
      budget.noteOutput(input);
    } catch (err) {
      if (err instanceof PreparationLimitExceededError) {
        diagnostics.push({ level: "error", message: err.message, code: "limit_exceeded" });
        return { text: "", diagnostics, touchedVars: EMPTY_TOUCHED_VARS, cacheable: true };
      }
      throw err;
    }
    return { text: input, diagnostics, touchedVars: EMPTY_TOUCHED_VARS, cacheable: true };
  }

  // Pre-process: legacy syntax conversion
  let processed = preprocessLegacy(input);

  const state: EvaluationState = {
    diagnostics,
    optionsMacroResolutionsCap: options?.maxMacroResolutions,
    activeExpansions: new Set(),
    halted: false,
    sourceOwner: options?.sourceOwner,
    budget,
  };
  let text = processed;

  const userId = typeof env.extra?.userId === "string" ? env.extra.userId : undefined;
  const runInterceptors = options?.sourceOwner !== "host" && macroInterceptorChain.count > 0;
  const phase = options?.phase ?? "other";
  const sourceHint = options?.sourceHint;

  // Fingerprint accumulator. Wrapped env records var reads via
  // env.variables.*.get/has; volatile macros flip cacheable=false.
  const fingerprint = { touched: new Set<string>(), cacheable: true };
  const recordingEnv = wrapEnvForFingerprint(env, fingerprint);

  // Iterative evaluation: most macros are now recursively expanded inline
  // (see evaluateMacroNode). The outer loop acts as a safety net for the
  // rare case where a macro result depends on state mutated by a later macro
  // in the same template that hasn't been evaluated yet.
  //
  // Expansion-budget breaches escape as PreparationLimitExceededError
  // rejections — the budget is the hard fail-closed authority — except the
  // construction-scale overages downgraded to per-macro skips inside
  // evaluateMacroNode/evaluateScopedMacroNode.
  const MAX_ITERATIONS = 2;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    budget.checkAbort();

    if (runInterceptors) {
      const interceptorResult = await macroInterceptorChain.run({
        template: text,
        env: snapshotEnvForInterceptor(env),
        commit: env.commit !== false,
        phase,
        ...(sourceHint ? { sourceHint } : {}),
        ...(userId !== undefined ? { userId } : {}),
      });
      text = interceptorResult.text;
      for (const v of interceptorResult.touchedVars) fingerprint.touched.add(v);
      if (interceptorResult.volatile || interceptorResult.opaque) {
        fingerprint.cacheable = false;
      }
      if (!text.includes("{{")) break;
    }
    const ast = parseForEvaluation(text, state);
    if (!ast) break;
    const result = await evaluateNodes(ast, recordingEnv, registry, 0, 0, state);
    if (result === text) break; // No change — converged
    text = result;
    if (!text.includes("{{")) break; // No more macros to resolve
  }

  // A limit failure is fail-closed. Returning a prefix would silently truncate
  // a prompt and change Response-mode semantics.
  if (state.halted) {
    return { text: "", diagnostics, touchedVars: fingerprint.touched, cacheable: fingerprint.cacheable };
  }

  // Post-process: unescape remaining escaped braces.
  const final = postprocess(text);
  try {
    budget.noteOutput(final);
  } catch (err) {
    if (err instanceof PreparationLimitExceededError) {
      diagnostics.push({ level: "error", message: err.message, code: "limit_exceeded" });
      return { text: "", diagnostics, touchedVars: fingerprint.touched, cacheable: fingerprint.cacheable };
    }
    throw err;
  }

  return { text: final, diagnostics, touchedVars: fingerprint.touched, cacheable: fingerprint.cacheable };
}

const EMPTY_TOUCHED_VARS: ReadonlySet<string> = new Set<string>();

/**
 * Offer one complete character prompt source to extension evaluators, then
 * continue the host's normal evaluation with the returned text.
 */
async function resolvePromptSource(
  input: string,
  sourceHint: string,
  env: MacroEnv,
): Promise<string | undefined> {
  if (macroInterceptorChain.count === 0) return undefined;

  const userId = typeof env.extra?.userId === "string" ? env.extra.userId : undefined;
  const result = await macroInterceptorChain.run({
    template: input,
    env: snapshotEnvForInterceptor(env),
    commit: env.commit !== false,
    phase: "prompt",
    sourceHint,
    ...(userId !== undefined ? { userId } : {}),
  });
  if (env._fingerprint) {
    for (const variable of result.touchedVars) env._fingerprint.touched.add(variable);
    if (result.volatile || result.opaque) env._fingerprint.cacheable = false;
  }

  return result.text;
}

interface MacroSourceReplacement {
  start: number;
  end: number;
  value: string;
}

/**
 * Resolve only static reads of prompt-variable keys owned by the current
 * preset block before a whole-template extension interceptor runs.
 *
 * Replacements are applied by source offset rather than reconstructing the
 * AST. That is important for compatibility interpreters: surrounding Risu
 * syntax, whitespace, separators, and namespaced macros remain exactly as the
 * author wrote them.
 */
async function preResolveProtectedPromptVariableReads(
  input: string,
  env: MacroEnv,
  registry: MacroRegistry,
  state: EvaluationState,
): Promise<string> {
  const protectedKeys = getProtectedPromptVariableKeys(env);
  if (protectedKeys.size === 0 || !input.includes("{{")) return input;

  let ast: AstNode[];
  try {
    ast = parse(input);
  } catch {
    // The normal evaluator owns parse diagnostics. A protective prepass must
    // never turn a recoverable extension template into a hard failure.
    return input;
  }

  const mutationScan = collectMutatedLocalVariableKeys(ast);
  const mutatedKeys = mutationScan.hasDynamicKey ? protectedKeys : mutationScan.keys;
  const candidates: MacroNode[] = [];
  collectProtectedPromptReadNodes(ast, protectedKeys, mutatedKeys, registry, candidates);
  if (candidates.length === 0) return input;

  const replacements: MacroSourceReplacement[] = [];
  for (const node of candidates) {
    const args = getStaticMacroArgs(node);
    if (!args) continue;
    const end = findMacroSourceEnd(input, node.offset);
    if (end === null || end <= node.offset) continue;

    const def = registry.getMacro(node.name);
    const origin = registry.getMacroOrigin(node.name);
    if (!def || origin?.kind !== "system") continue;

    try {
      const value = String(
        await Promise.resolve(
          def.handler(buildExecContext(node, args, env, registry, 0, 0, state)),
        ),
      );
      state.budget.preflightOutput(value);
      state.budget.accountExpansion(value);
      replacements.push({ start: node.offset, end, value });
    } catch {
      // Leave the original macro for the normal evaluator, which will report
      // its existing diagnostic with the correct macro name and offset.
    }
  }

  if (replacements.length === 0) return input;
  replacements.sort((a, b) => a.start - b.start);
  let outputBytes = Buffer.byteLength(input, "utf8");
  let cursor = 0;
  const parts: string[] = [];
  for (const replacement of replacements) {
    if (replacement.start < cursor || replacement.end > input.length) return input;
    const source = input.slice(cursor, replacement.start);
    const replacedSource = input.slice(replacement.start, replacement.end);
    outputBytes += state.budget.preflightOutput(replacement.value)
      - Buffer.byteLength(replacedSource, "utf8");
    state.budget.preflightOutput(outputBytes);
    parts.push(source, replacement.value);
    cursor = replacement.end;
  }
  parts.push(input.slice(cursor));
  state.budget.preflightOutput(outputBytes);
  return parts.join("");
}

function getProtectedPromptVariableKeys(env: MacroEnv): Set<string> {
  const blockId = env.promptBlock?.id;
  const valuesByBlock = env.extra.promptVariablesByBlock as
    | Record<string, Record<string, string | number>>
    | undefined;
  const defaultsByBlock = env.extra.promptVariableDefaultsByBlock as
    | Record<string, Record<string, string | number>>
    | undefined;
  const values = blockId && valuesByBlock?.[blockId]
    ? valuesByBlock[blockId]
    : env.extra.promptVariables as Record<string, string | number> | undefined;
  const defaults = blockId && defaultsByBlock?.[blockId]
    ? defaultsByBlock[blockId]
    : env.extra.promptVariableDefaults as Record<string, string | number> | undefined;

  return new Set([
    ...Object.keys(values ?? {}),
    ...Object.keys(defaults ?? {}),
  ]);
}

function collectProtectedPromptReadNodes(
  nodes: AstNode[],
  protectedKeys: ReadonlySet<string>,
  mutatedKeys: ReadonlySet<string>,
  registry: MacroRegistry,
  output: MacroNode[],
): void {
  for (const node of nodes) {
    if (node.type === "text") continue;

    if (node.type === "macro") {
      const name = node.name.toLowerCase();
      const key = getStaticMacroKey(node);
      if (
        key !== null
        && PROTECTED_PROMPT_READ_NAMES.has(name)
        && protectedKeys.has(key)
        && !mutatedKeys.has(key)
        && registry.getMacroOrigin(node.name)?.kind === "system"
      ) {
        output.push(node);
      }
    }

    for (const arg of node.args) {
      collectProtectedPromptReadNodes(arg, protectedKeys, mutatedKeys, registry, output);
    }
    if (node.type === "scoped_macro") {
      collectProtectedPromptReadNodes(node.body, protectedKeys, mutatedKeys, registry, output);
    }
  }
}

interface LocalVariableMutationScan {
  keys: Set<string>;
  hasDynamicKey: boolean;
}

function collectMutatedLocalVariableKeys(
  nodes: AstNode[],
  scan: LocalVariableMutationScan = { keys: new Set<string>(), hasDynamicKey: false },
): LocalVariableMutationScan {
  for (const node of nodes) {
    if (node.type === "text") continue;
    if (LOCAL_VARIABLE_MUTATION_NAMES.has(node.name.toLowerCase())) {
      const key = getStaticMacroKey(node);
      if (key !== null) scan.keys.add(key);
      else scan.hasDynamicKey = true;
    }
    // {{let}} / {{withVar}} temporarily mutate an arbitrary list of local
    // bindings. Conservatively protect every statically named binding.
    if (["let", "withvar", "scope"].includes(node.name.toLowerCase())) {
      for (let i = 0; i < node.args.length; i += 2) {
        const rawKey = getStaticNodeText(node.args[i] ?? []);
        const key = rawKey?.trim();
        if (key) scan.keys.add(key);
        else if (rawKey === null) scan.hasDynamicKey = true;
      }
    }
    for (const arg of node.args) {
      collectMutatedLocalVariableKeys(arg, scan);
    }
    if (node.type === "scoped_macro") {
      collectMutatedLocalVariableKeys(node.body, scan);
    }
  }
  return scan;
}

function getStaticMacroKey(node: MacroNode | ScopedMacroNode): string | null {
  const key = getStaticNodeText(node.args[0] ?? []);
  if (key === null) return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getStaticMacroArgs(node: MacroNode): string[] | null {
  const args: string[] = [];
  for (const arg of node.args) {
    const value = getStaticNodeText(arg);
    if (value === null) return null;
    args.push(value);
  }
  return args;
}

function getStaticNodeText(nodes: AstNode[]): string | null {
  let value = "";
  for (const node of nodes) {
    if (node.type !== "text") return null;
    value += node.value;
  }
  return value;
}

function findMacroSourceEnd(input: string, start: number): number | null {
  if (start < 0 || input.slice(start, start + 2) !== "{{") return null;
  let depth = 0;
  for (let i = start; i < input.length - 1; i++) {
    if (isEscapedSourceOffset(input, i)) continue;
    const pair = input.slice(i, i + 2);
    if (pair === "{{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (pair === "}}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function isEscapedSourceOffset(input: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && input[i] === "\\"; i--) slashes += 1;
  return (slashes & 1) === 1;
}

function wrapEnvForFingerprint(
  env: MacroEnv,
  fingerprint: { touched: Set<string>; cacheable: boolean },
): MacroEnv {
  const wrappedVars = {
    local: makeRecordingMap(env.variables.local, "local", fingerprint.touched),
    global: makeRecordingMap(env.variables.global, "global", fingerprint.touched),
    chat: makeRecordingMap(env.variables.chat, "chat", fingerprint.touched),
  };
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "variables") return wrappedVars;
      if (prop === "_fingerprint") return fingerprint;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === "variables" || prop === "_fingerprint") return true;
      return Reflect.set(target, prop, value, receiver);
    },
  }) as MacroEnv;
}

function makeRecordingMap(
  source: Map<string, string>,
  scope: "local" | "global" | "chat",
  sink: Set<string>,
): Map<string, string> {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return (key: string) => {
          sink.add(`${scope}:${key}`);
          return target.get(key);
        };
      }
      if (prop === "has") {
        return (key: string) => {
          sink.add(`${scope}:${key}`);
          return target.has(key);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function preprocessLegacy(input: string): string {
  // Convert {{time_UTC+2}} → {{time::UTC+2}} pattern
  return input.replace(/\{\{time_([^}]+)\}\}/g, "{{time::$1}}");
}

function postprocess(text: string): string {
  // Convert sentinel characters back to actual braces
  return text.replaceAll(ESCAPED_OPEN, "{").replaceAll(ESCAPED_CLOSE, "}");
}

async function evaluateNodes(
  nodes: AstNode[],
  env: MacroEnv,
  registry: MacroRegistry,
  globalOffset: number,
  depth: number,
  state: EvaluationState,
): Promise<string> {
  if (state.halted) return "";

  // Deep finite macro trees should not be rejected, but periodically yielding
  // prevents recursive async evaluation from monopolizing the JS stack.
  if (depth > 0 && depth % ASYNC_UNWIND_INTERVAL === 0) {
    await Promise.resolve();
  }

  state.budget.checkAbort();

  if (!consumeMacroBudget(nodes, state)) {
    return "";
  }

  let result = "";

  for (const node of nodes) {
    if (state.halted) break;

    let fragment: string;
    switch (node.type) {
      case "text":
        fragment = node.value;
        break;
      case "macro":
        fragment = await evaluateMacroNode(node, env, registry, globalOffset, depth, state);
        break;
      case "scoped_macro":
        fragment = await evaluateScopedMacroNode(node, env, registry, globalOffset, depth, state);
        break;
    }

    // Output and expansion bytes are charged exactly once: built-ins preflight
    // their own constructions, each handler result is accounted in
    // evaluateMacroNode/evaluateScopedMacroNode, and the final rendered text
    // is checked by evaluate()'s closing noteOutput. Re-checking running
    // fragments here would double-charge composed results.
    result += fragment;
  }

  return result;
}

/**
 * Strip "structural" leading/trailing whitespace from a macro argument — the
 * newline + indentation a template author types when laying a nested macro out
 * across multiple lines for readability, e.g.
 *
 *   {{setvar::cotexpand::
 *     {{join::{{newline}}::...}}
 *   }}
 *
 * Without this, the `\n  ` after `::` and the `\n` before the closing `}}` are
 * captured as part of the argument and leak into the stored value (and then
 * accumulate across rounds). We only strip whitespace runs that CONTAIN A
 * NEWLINE, and only from the first/last nodes when they are literal text. That
 * deliberately preserves:
 *   - whitespace produced by a macro — {{join::{{newline}}::...}} keeps its
 *     "\n" separator, because {{newline}} is a macro node, never a boundary
 *     text node;
 *   - inline padding the author typed on one line — {{join:: | ::a::b}} keeps
 *     " | " and {{setvar::x:: - }} keeps " - ", since those runs have no newline.
 *
 * Returns the original array unchanged (no allocation) when nothing is trimmed,
 * which is the common case. Never mutates the input (the AST is cached).
 */
function stripArgFraming(nodes: AstNode[]): AstNode[] {
  if (nodes.length === 0) return nodes;

  // Single text node: strip both ends.
  if (nodes.length === 1) {
    const only = nodes[0];
    if (only.type !== "text") return nodes;
    const stripped = stripTrailingLineWs(stripLeadingLineWs(only.value));
    if (stripped === only.value) return nodes;
    return stripped === "" ? [] : [{ type: "text", value: stripped }];
  }

  let out: AstNode[] | null = null;

  const first = nodes[0];
  if (first.type === "text") {
    const stripped = stripLeadingLineWs(first.value);
    if (stripped !== first.value) {
      out = nodes.slice();
      if (stripped === "") out.shift();
      else out[0] = { type: "text", value: stripped } satisfies TextNode;
    }
  }

  const arr = out ?? nodes;
  const lastIdx = arr.length - 1;
  const last = arr[lastIdx];
  if (lastIdx >= 0 && last.type === "text") {
    const stripped = stripTrailingLineWs(last.value);
    if (stripped !== last.value) {
      if (!out) out = nodes.slice();
      const i = out.length - 1;
      if (stripped === "") out.pop();
      else out[i] = { type: "text", value: stripped } satisfies TextNode;
    }
  }

  return out ?? nodes;
}

/** Remove a leading whitespace run only when it spans a line break. */
function stripLeadingLineWs(value: string): string {
  const m = /^\s+/.exec(value);
  return m && m[0].includes("\n") ? value.slice(m[0].length) : value;
}

/** Remove a trailing whitespace run only when it spans a line break. */
function stripTrailingLineWs(value: string): string {
  const m = /\s+$/.exec(value);
  return m && m[0].includes("\n") ? value.slice(0, value.length - m[0].length) : value;
}

async function evaluateMacroNode(
  node: MacroNode,
  env: MacroEnv,
  registry: MacroRegistry,
  globalOffset: number,
  depth: number,
  state: EvaluationState,
): Promise<string> {
  const def = registry.getMacro(node.name);
  const origin = registry.getMacroOrigin(node.name);

  // Preset/request macros override extension registrations, but never system
  // macros. This keeps host behavior stable while allowing presets to define
  // their own values without an extension globally shadowing them.
  const dynamicKey = node.name.toLowerCase();
  const dynamicLookup = env._dynamicMacrosLower;
  if (origin?.kind !== "system" && dynamicLookup && dynamicLookup.has(dynamicKey)) {
    if (env._fingerprint) env._fingerprint.cacheable = false;
    const dynamic = dynamicLookup.get(dynamicKey)!;
    let rawResult: string;
    if (typeof dynamic === "string") {
      rawResult = dynamic;
    } else if (typeof dynamic === "function") {
      rawResult = String(
        await Promise.resolve(
          dynamic(buildExecContext(node, [], env, registry, globalOffset, depth, state))
        )
      );
    } else if (typeof dynamic === "object" && dynamic.handler) {
      rawResult = String(
        await Promise.resolve(
          dynamic.handler(buildExecContext(node, [], env, registry, globalOffset, depth, state))
        )
      );
    } else {
      rawResult = String(dynamic);
    }
    try {
      state.budget.accountExpansion(rawResult);
    } catch (err: unknown) {
      if (skipMacroOnBudgetLimit(err, state, node)) return "";
      throw err;
    }
    // Dynamic macros don't carry a terminal flag, so always check for nested
    // macros to stay consistent with registry macro behavior.
    return await expandIfNeeded(rawResult, env, registry, globalOffset, depth, state);
  }

  if (!def) {
    // Unknown macro — pass through as-is
    return reconstructMacro(node);
  }

  if (def.volatile && env._fingerprint) env._fingerprint.cacheable = false;

  // Resolve arguments (unless handler wants raw AST)
  let resolvedArgs: string[];
  if (def.delayArgResolution) {
    resolvedArgs = [];
  } else {
    resolvedArgs = [];
    for (const argNodes of node.args) {
      resolvedArgs.push(
        await evaluateNodes(stripArgFraming(argNodes), env, registry, globalOffset, depth + 1, state)
      );
      if (state.halted) return "";
    }
  }

  if (state.halted) return "";

  const ctx = buildExecContext(node, resolvedArgs, env, registry, globalOffset, depth, state);

  try {
    const rawResult = String(await Promise.resolve(def.handler(ctx)));
    // Account the exact handler result only after built-ins have preflighted
    // any potentially large construction (repeat/join/regex/etc.).
    state.budget.accountExpansion(rawResult);

    // Recursive inline expansion: if the handler returned text containing
    // unresolved macros, expand them immediately rather than deferring to
    // the next outer pass.
    if (!def.terminal) {
      return await expandIfNeeded(rawResult, env, registry, globalOffset, depth, state);
    }

    return rawResult;
  } catch (err: unknown) {
    if (skipMacroOnBudgetLimit(err, state, node)) return "";
    if (err instanceof PreparationLimitExceededError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const message = err instanceof Error ? err.message : String(err);
    state.diagnostics.push({
      level: "error",
      message: `Error in macro {{${node.name}}}: ${message}`,
      macroName: node.name,
      offset: node.offset,
    });
    return "";
  }
}

/**
 * If `text` contains unresolved macro markers, parse and recursively evaluate
 * it inline. Returns the original text when no markers remain or when
 * expansion converges (no change).
 */
async function expandIfNeeded(
  text: string,
  env: MacroEnv,
  registry: MacroRegistry,
  globalOffset: number,
  depth: number,
  state: EvaluationState,
): Promise<string> {
  if (!text.includes("{{") || state.halted) return text;
  if (state.activeExpansions.has(text)) {
    state.diagnostics.push({
      level: "error",
      message: "Recursive macro expansion detected; leaving unresolved macro text",
    });
    return text;
  }

  const innerAst = parseForEvaluation(text, state);
  if (!innerAst) return text;

  state.activeExpansions.add(text);
  let expanded: string;
  try {
    expanded = await evaluateNodes(innerAst, env, registry, globalOffset, depth + 1, state);
  } finally {
    state.activeExpansions.delete(text);
  }
  // Convergence guard: avoid infinite recursion from self-referential
  // variables (e.g., x = "{{getvar::x}}") by checking if expansion
  // actually changed the text.
  return expanded !== text ? expanded : text;
}

async function evaluateScopedMacroNode(
  node: ScopedMacroNode,
  env: MacroEnv,
  registry: MacroRegistry,
  globalOffset: number,
  depth: number,
  state: EvaluationState,
): Promise<string> {
  const def = registry.getMacro(node.name);

  if (!def) {
    // Unknown scoped macro — evaluate body and return it
    return await evaluateNodes(node.body, env, registry, globalOffset, depth + 1, state);
  }

  // Resolve arguments
  let resolvedArgs: string[];
  if (def.delayArgResolution) {
    resolvedArgs = [];
  } else {
    resolvedArgs = [];
    for (const argNodes of node.args) {
      resolvedArgs.push(
        await evaluateNodes(stripArgFraming(argNodes), env, registry, globalOffset, depth + 1, state)
      );
      if (state.halted) return "";
    }
  }

  // Delayed-resolution scoped macros (currently {{if}}) need access to the raw
  // body so they can choose which branch to resolve without triggering side
  // effects in the unselected branch.
  const body = def.delayArgResolution
    ? reconstructNodes(node.body)
    : await evaluateNodes(node.body, env, registry, globalOffset, depth + 1, state);

  if (state.halted) return "";

  const ctx: MacroExecContext = {
    name: node.name,
    args: resolvedArgs,
    rawArgs: node.args,
    flags: node.flags,
    commit: env.commit !== false,
    isScoped: true,
    body,
    bodyRaw: node.body,
    offset: node.offset,
    globalOffset,
    env,
    budget: state.budget,
    reserveExpansion: (value: string | number, operationBytes?: number) =>
      state.budget.preflightExpansion(value, operationBytes),
    reserveOutput: (value: string | number) => state.budget.preflightOutput(value),
    append: (parts: readonly string[]) => state.budget.append(parts),
    resolve: (text: string) => {
      const innerAst = parseForEvaluation(text, state);
      return innerAst ? evaluateNodes(innerAst, env, registry, globalOffset, depth + 1, state) : text;
    },
    resolveNodes: (nodes: AstNode[]) =>
      evaluateNodes(nodes, env, registry, globalOffset, depth + 1, state),
    ...(state.sourceOwner === "host"
      ? {
          resolvePromptSource: (input: string, sourceHint: string) =>
            resolvePromptSource(input, sourceHint, env),
        }
      : {}),
    warn: (message: string) => {
      state.diagnostics.push({ level: "warn", message, macroName: node.name, offset: node.offset });
    },
  };

  try {
    const rawResult = String(await Promise.resolve(def.handler(ctx)));
    state.budget.accountExpansion(rawResult);

    // Recursive inline expansion — same pattern as evaluateMacroNode.
    if (!def.terminal) {
      return await expandIfNeeded(rawResult, env, registry, globalOffset, depth, state);
    }

    return rawResult;
  } catch (err: unknown) {
    if (skipMacroOnBudgetLimit(err, state, node)) return "";
    if (err instanceof PreparationLimitExceededError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const message = err instanceof Error ? err.message : String(err);
    state.diagnostics.push({
      level: "error",
      message: `Error in scoped macro {{${node.name}}}: ${message}`,
      macroName: node.name,
      offset: node.offset,
    });
    return "";
  }
}

function buildExecContext(
  node: MacroNode,
  resolvedArgs: string[],
  env: MacroEnv,
  registry: MacroRegistry,
  globalOffset: number,
  depth: number,
  state: EvaluationState,
): MacroExecContext {
  return {
    name: node.name,
    args: resolvedArgs,
    rawArgs: node.args,
    flags: node.flags,
    commit: env.commit !== false,
    isScoped: false,
    body: "",
    bodyRaw: [],
    reserveExpansion: (value: string | number, operationBytes?: number) =>
      state.budget.preflightExpansion(value, operationBytes),
    reserveOutput: (value: string | number) => state.budget.preflightOutput(value),
    append: (parts: readonly string[]) => state.budget.append(parts),
    offset: node.offset,
    globalOffset,
    env,
    budget: state.budget,
    resolve: (text: string) => {
      const innerAst = parseForEvaluation(text, state);
      return innerAst ? evaluateNodes(innerAst, env, registry, globalOffset, depth + 1, state) : text;
    },
    resolveNodes: (nodes: AstNode[]) =>
      evaluateNodes(nodes, env, registry, globalOffset, depth + 1, state),
    ...(state.sourceOwner === "host"
      ? {
          resolvePromptSource: (input: string, sourceHint: string) =>
            resolvePromptSource(input, sourceHint, env),
        }
      : {}),
    warn: (message: string) => {
      state.diagnostics.push({ level: "warn", message, macroName: node.name, offset: node.offset });
    },
  };
}

function parseForEvaluation(input: string, state: EvaluationState): AstNode[] | null {
  try {
    return parse(input);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.diagnostics.push({
      level: "error",
      message: `Macro parse failed: ${message}`,
    });
    state.halted = true;
    return null;
  }
}

/**
 * Classify a budget limit raised while one macro handler ran.
 *
 * Construction-scale overages — a per-operation ceiling breach, or a
 * cumulative breach with nothing charged yet (the construction alone exceeds
 * the whole cumulative allowance) — skip just the offending macro (empty
 * expansion + diagnostic) and keep evaluating the template. Any other breach
 * (an output ceiling the final text could never satisfy, or a cumulative
 * budget already partially consumed) is template-scale and must fail closed
 * by rejecting the whole evaluation.
 */
function skipMacroOnBudgetLimit(
  err: unknown,
  state: EvaluationState,
  node: MacroNode | ScopedMacroNode,
): boolean {
  if (!(err instanceof PreparationLimitExceededError)) return false;
  const constructionScale = err.dimension === "operation_bytes"
    || (err.dimension === "cumulative_expansion_bytes" && state.budget.cumulativeExpansionBytes === 0);
  if (!constructionScale) return false;
  state.diagnostics.push({
    level: "error",
    message: err.message,
    code: "limit_exceeded",
    macroName: node.name,
    offset: node.offset,
  });
  return true;
}

function consumeMacroBudget(nodes: AstNode[], state: EvaluationState): boolean {
  if (state.halted) return false;

  let count = 0;
  for (const node of nodes) {
    if (node.type === "macro" || node.type === "scoped_macro") count++;
  }
  if (count === 0) return true;

  // The legacy per-call options cap stays a soft halt so historic callers
  // keep receiving a stable fail-closed result with diagnostics.
  if (state.optionsMacroResolutionsCap !== undefined
    && state.budget.macroResolutions + count > state.optionsMacroResolutionsCap) {
    state.halted = true;
    state.diagnostics.push({
      level: "error",
      message: `Macro resolution budget exceeded (${state.optionsMacroResolutionsCap})`,
    });
    return false;
  }

  // The expansion budget is the hard authority: a breach rejects the whole
  // evaluation (PreparationLimitExceededError propagates).
  state.budget.reserveMacroResolutions(count);
  return true;
}

function snapshotEnvForInterceptor(env: MacroEnv): {
  commit: boolean;
  names: MacroEnv["names"];
  character: MacroEnv["character"];
  chat: MacroEnv["chat"];
  system: MacroEnv["system"];
  variables: {
    local: Record<string, string>;
    global: Record<string, string>;
    chat: Record<string, string>;
  };
  dynamicMacros: Record<string, string>;
  extra: Record<string, unknown>;
} {
  const dyn: Record<string, string> = {};
  for (const k of Object.keys(env.dynamicMacros || {})) {
    const v = env.dynamicMacros[k];
    if (typeof v === "string") dyn[k] = v;
  }
  return {
    commit: env.commit !== false,
    names: { ...env.names },
    character: { ...env.character },
    chat: { ...env.chat },
    system: { ...env.system },
    variables: {
      local: Object.fromEntries(env.variables.local),
      global: Object.fromEntries(env.variables.global),
      chat: Object.fromEntries(env.variables.chat),
    },
    dynamicMacros: dyn,
    extra: { ...env.extra },
  };
}

function reconstructMacro(node: MacroNode): string {
  let str = "{{";
  if (node.flags.immediate) str += "!";
  if (node.flags.delayed) str += "?";
  if (node.flags.reevaluate) str += "~";
  if (node.flags.filter) str += ">";
  if (node.flags.close) str += "/";
  if (node.flags.preserveWhitespace) str += "#";
  str += node.name;
  for (const arg of node.args) {
    str += "::";
    for (const n of arg) {
      if (n.type === "text") str += n.value;
      else if (n.type === "macro") str += reconstructMacro(n);
    }
  }
  str += "}}";
  return str;
}

function reconstructScopedMacro(node: ScopedMacroNode): string {
  let str = "{{";
  if (node.flags.immediate) str += "!";
  if (node.flags.delayed) str += "?";
  if (node.flags.reevaluate) str += "~";
  if (node.flags.filter) str += ">";
  if (node.flags.preserveWhitespace) str += "#";
  str += node.name;
  for (const arg of node.args) {
    str += "::";
    str += reconstructNodes(arg);
  }
  str += "}}";
  str += reconstructNodes(node.body);
  str += `{{/${node.name}}}`;
  return str;
}

function reconstructNodes(nodes: AstNode[]): string {
  let str = "";
  for (const node of nodes) {
    if (node.type === "text") str += node.value;
    else if (node.type === "macro") str += reconstructMacro(node);
    else str += reconstructScopedMacro(node);
  }
  return str;
}
