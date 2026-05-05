import type {
  AstNode,
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

const MAX_NESTING_DEPTH = 20;

export interface EvaluateOptions {
  phase?: MacroInterceptorPhase;
  sourceHint?: string;
}

const HAS_MACRO_RE = /\{\{|<(?:user|char|bot)>/i;

/**
 * Evaluate a macro template string, resolving all macros using the provided
 * environment and registry.
 */
export async function evaluate(
  input: string,
  env: MacroEnv,
  registry: MacroRegistry,
  options?: EvaluateOptions,
): Promise<EvaluateResult> {
  if (!input) return { text: "", diagnostics: [], touchedVars: EMPTY_TOUCHED_VARS, cacheable: true };

  // Fast-path: skip the entire lex/parse/evaluate pipeline when there are
  // no macro markers in the input (the vast majority of stored chat messages).
  if (!HAS_MACRO_RE.test(input)) {
    return { text: input, diagnostics: [], touchedVars: EMPTY_TOUCHED_VARS, cacheable: true };
  }

  // Pre-process: legacy syntax conversion
  let processed = preprocessLegacy(input);

  const diagnostics: MacroDiagnostic[] = [];
  let text = processed;

  const userId = typeof env.extra?.userId === "string" ? env.extra.userId : undefined;
  const runInterceptors = macroInterceptorChain.count > 0;
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
  const MAX_ITERATIONS = 2;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (env.signal?.aborted) throw env.signal.reason ?? new DOMException("Aborted", "AbortError");

    if (runInterceptors) {
      const beforeInterceptor = text;
      text = await macroInterceptorChain.run({
        template: text,
        env: snapshotEnvForInterceptor(env),
        commit: env.commit !== false,
        phase,
        ...(sourceHint ? { sourceHint } : {}),
        ...(userId !== undefined ? { userId } : {}),
      });
      if (text !== beforeInterceptor) fingerprint.cacheable = false;
      if (!text.includes("{{")) break;
    }

    const ast = parse(text);
    const result = await evaluateNodes(ast, recordingEnv, registry, 0, 0, diagnostics);
    if (result === text) break; // No change — converged
    text = result;
    if (!text.includes("{{")) break; // No more macros to resolve
  }

  // Post-process: unescape remaining escaped braces
  const final = postprocess(text);

  return { text: final, diagnostics, touchedVars: fingerprint.touched, cacheable: fingerprint.cacheable };
}

const EMPTY_TOUCHED_VARS: ReadonlySet<string> = new Set<string>();

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
  diagnostics: MacroDiagnostic[],
): Promise<string> {
  if (depth > MAX_NESTING_DEPTH) {
    diagnostics.push({
      level: "error",
      message: `Maximum nesting depth (${MAX_NESTING_DEPTH}) exceeded`,
    });
    return "";
  }

  let result = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result += node.value;
        break;

      case "macro":
        result += await evaluateMacroNode(node, env, registry, globalOffset, depth, diagnostics);
        break;

      case "scoped_macro":
        result += await evaluateScopedMacroNode(node, env, registry, globalOffset, depth, diagnostics);
        break;
    }
  }

  return result;
}

async function evaluateMacroNode(
  node: MacroNode,
  env: MacroEnv,
  registry: MacroRegistry,
  globalOffset: number,
  depth: number,
  diagnostics: MacroDiagnostic[],
): Promise<string> {
  const def = registry.getMacro(node.name);

  // Check dynamic macros via pre-normalized lowercase map (O(1) lookup)
  const dynamicKey = node.name.toLowerCase();
  const dynamicLookup = env._dynamicMacrosLower;
  if (!def && dynamicLookup && dynamicLookup.has(dynamicKey)) {
    if (env._fingerprint) env._fingerprint.cacheable = false;
    const dynamic = dynamicLookup.get(dynamicKey)!;
    let rawResult: string;
    if (typeof dynamic === "string") {
      rawResult = dynamic;
    } else if (typeof dynamic === "function") {
      rawResult = String(
        await Promise.resolve(
          dynamic(buildExecContext(node, [], env, registry, globalOffset, depth, diagnostics))
        )
      );
    } else if (typeof dynamic === "object" && dynamic.handler) {
      rawResult = String(
        await Promise.resolve(
          dynamic.handler(buildExecContext(node, [], env, registry, globalOffset, depth, diagnostics))
        )
      );
    } else {
      rawResult = String(dynamic);
    }
    // Dynamic macros don't carry a terminal flag, so always check for nested
    // macros to stay consistent with registry macro behavior.
    return await expandIfNeeded(rawResult, env, registry, globalOffset, depth, diagnostics);
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
        await evaluateNodes(argNodes, env, registry, globalOffset, depth + 1, diagnostics)
      );
    }
  }

  const ctx = buildExecContext(node, resolvedArgs, env, registry, globalOffset, depth, diagnostics);

  try {
    const rawResult = String(await Promise.resolve(def.handler(ctx)));

    // Recursive inline expansion: if the handler returned text containing
    // unresolved macros, expand them immediately rather than deferring to
    // the next outer pass. This collapses multi-pass chains (e.g.
    // {{getvar::x}} → "{{user}}" → "Alice") into a single depth-first pass.
    // Terminal macros (guaranteed never to return {{...}}) skip the check.
    if (!def.terminal) {
      return await expandIfNeeded(rawResult, env, registry, globalOffset, depth, diagnostics);
    }

    return rawResult;
  } catch (err: any) {
    diagnostics.push({
      level: "error",
      message: `Error in macro {{${node.name}}}: ${err.message}`,
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
  diagnostics: MacroDiagnostic[],
): Promise<string> {
  if (!text.includes("{{") || depth >= MAX_NESTING_DEPTH) return text;
  const innerAst = parse(text);
  const expanded = await evaluateNodes(innerAst, env, registry, globalOffset, depth + 1, diagnostics);
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
  diagnostics: MacroDiagnostic[],
): Promise<string> {
  const def = registry.getMacro(node.name);

  if (!def) {
    // Unknown scoped macro — evaluate body and return it
    return await evaluateNodes(node.body, env, registry, globalOffset, depth + 1, diagnostics);
  }

  // Resolve arguments
  let resolvedArgs: string[];
  if (def.delayArgResolution) {
    resolvedArgs = [];
  } else {
    resolvedArgs = [];
    for (const argNodes of node.args) {
      resolvedArgs.push(
        await evaluateNodes(argNodes, env, registry, globalOffset, depth + 1, diagnostics)
      );
    }
  }

  // Delayed-resolution scoped macros (currently {{if}}) need access to the raw
  // body so they can choose which branch to resolve without triggering side
  // effects in the unselected branch.
  const body = def.delayArgResolution
    ? reconstructNodes(node.body)
    : await evaluateNodes(node.body, env, registry, globalOffset, depth + 1, diagnostics);

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
    resolve: (text: string) => {
      const innerAst = parse(text);
      return evaluateNodes(innerAst, env, registry, globalOffset, depth + 1, diagnostics);
    },
    resolveNodes: (nodes: AstNode[]) =>
      evaluateNodes(nodes, env, registry, globalOffset, depth + 1, diagnostics),
    warn: (message: string) => {
      diagnostics.push({ level: "warn", message, macroName: node.name, offset: node.offset });
    },
  };

  try {
    const rawResult = String(await Promise.resolve(def.handler(ctx)));

    // Recursive inline expansion — same pattern as evaluateMacroNode.
    if (!def.terminal) {
      return await expandIfNeeded(rawResult, env, registry, globalOffset, depth, diagnostics);
    }

    return rawResult;
  } catch (err: any) {
    diagnostics.push({
      level: "error",
      message: `Error in scoped macro {{${node.name}}}: ${err.message}`,
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
  diagnostics: MacroDiagnostic[],
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
    offset: node.offset,
    globalOffset,
    env,
    resolve: (text: string) => {
      const innerAst = parse(text);
      return evaluateNodes(innerAst, env, registry, globalOffset, depth + 1, diagnostics);
    },
    resolveNodes: (nodes: AstNode[]) =>
      evaluateNodes(nodes, env, registry, globalOffset, depth + 1, diagnostics),
    warn: (message: string) => {
      diagnostics.push({ level: "warn", message, macroName: node.name, offset: node.offset });
    },
  };
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
