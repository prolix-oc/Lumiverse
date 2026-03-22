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
import { parse } from "./MacroParser";
import { MacroRegistry } from "./MacroRegistry";

const MAX_NESTING_DEPTH = 20;
const LEGACY_MACRO_MAP: Record<string, string> = {
  "<USER>": "{{user}}",
  "<BOT>": "{{char}}",
  "<CHAR>": "{{char}}",
};

/**
 * Evaluate a macro template string, resolving all macros using the provided
 * environment and registry.
 */
export async function evaluate(
  input: string,
  env: MacroEnv,
  registry: MacroRegistry,
): Promise<EvaluateResult> {
  if (!input) return { text: "", diagnostics: [] };

  // Fast-path: skip the entire lex/parse/evaluate pipeline when there are
  // no macro markers in the input (the vast majority of stored chat messages).
  if (!input.includes("{{") && !input.includes("<USER>") && !input.includes("<BOT>") && !input.includes("<CHAR>")) {
    return { text: input, diagnostics: [] };
  }

  // Pre-process: legacy syntax conversion
  let processed = preprocessLegacy(input);

  const diagnostics: MacroDiagnostic[] = [];
  let text = processed;

  // Iterative evaluation: re-evaluate if output still contains macros
  // (handles macros that resolve to text containing other macros)
  const MAX_ITERATIONS = 5;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const ast = parse(text);
    const result = await evaluateNodes(ast, env, registry, 0, 0, diagnostics);
    if (result === text) break; // No change — converged
    text = result;
    if (!text.includes("{{")) break; // No more macros to resolve
  }

  // Post-process: unescape remaining escaped braces
  const final = postprocess(text);

  return { text: final, diagnostics };
}

function preprocessLegacy(input: string): string {
  let result = input;

  // Replace <USER>, <BOT>, <CHAR> legacy tokens
  for (const [legacy, replacement] of Object.entries(LEGACY_MACRO_MAP)) {
    result = result.replaceAll(legacy, replacement);
  }

  // Convert {{time_UTC+2}} → {{time::UTC+2}} pattern
  result = result.replace(/\{\{time_([^}]+)\}\}/g, "{{time::$1}}");

  return result;
}

function postprocess(text: string): string {
  return text;
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
    const dynamic = dynamicLookup.get(dynamicKey)!;
    if (typeof dynamic === "string") return dynamic;
    if (typeof dynamic === "function") {
      return String(
        await Promise.resolve(
          dynamic(buildExecContext(node, [], env, registry, globalOffset, depth, diagnostics))
        )
      );
    }
    if (typeof dynamic === "object" && dynamic.handler) {
      return String(
        await Promise.resolve(
          dynamic.handler(buildExecContext(node, [], env, registry, globalOffset, depth, diagnostics))
        )
      );
    }
    return String(dynamic);
  }

  if (!def) {
    // Unknown macro — pass through as-is
    return reconstructMacro(node);
  }

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
    return String(await Promise.resolve(def.handler(ctx)));
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

  // Resolve body
  const body = await evaluateNodes(node.body, env, registry, globalOffset, depth + 1, diagnostics);

  const ctx: MacroExecContext = {
    name: node.name,
    args: resolvedArgs,
    rawArgs: node.args,
    flags: node.flags,
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
    return String(await Promise.resolve(def.handler(ctx)));
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
