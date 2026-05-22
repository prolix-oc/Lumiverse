import type { AstNode, MacroNode } from "../types";
import { registry } from "../MacroRegistry";

const ELSE_MARKER = "\x00ELSE_MARKER\x00";

export function registerCoreMacros(): void {
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "space",
    category: "Core",
    description: "Inserts a literal space character",
    returnType: "string",
    handler: () => " ",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "newline",
    category: "Core",
    description: "Inserts a literal newline character",
    returnType: "string",
    aliases: ["nl", "n"],
    handler: () => "\n",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "noop",
    category: "Core",
    description: "No operation — resolves to empty string",
    returnType: "string",
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "trim",
    category: "Core",
    description: "Trim whitespace from scoped content or surrounding whitespace in post mode",
    returnType: "string",
    handler: (ctx) => {
      if (ctx.isScoped) {
        // {{#trim}}...{{/trim}} — preserve whitespace (ST compat)
        if (ctx.flags.preserveWhitespace) return ctx.body;
        // {{trim}}...{{/trim}} — strip blank lines, dedent, and trim
        return dedent(ctx.body).trim();
      }
      // Non-scoped trim acts as a marker; handled in post-processing
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "comment",
    category: "Core",
    description: "Comment — resolves to empty string, content is ignored",
    returnType: "string",
    aliases: ["note"],
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "//",
    category: "Core",
    description: "Inline comment shorthand — resolves to empty string",
    returnType: "string",
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    name: "input",
    category: "Core",
    description: "Resolves to the raw user input (last user message)",
    returnType: "string",
    handler: (ctx) => ctx.env.chat.lastUserMessage,
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "reverse",
    category: "Core",
    description: "Reverse a string",
    returnType: "string",
    args: [{ name: "text", description: "Text to reverse" }],
    handler: (ctx) => {
      if (ctx.isScoped) return [...ctx.body].reverse().join("");
      return ctx.args[0] ? [...ctx.args[0]].reverse().join("") : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "outlet",
    category: "Core",
    description: "Resolve an activated world-info outlet by name",
    returnType: "string",
    args: [{ name: "name", description: "Outlet name configured on a world-info entry" }],
    handler: (ctx) => {
      const name = (ctx.args[0] || "").trim().toLowerCase();
      if (!name) return "";
      const outlets = ctx.env.extra?.worldInfoOutlets as Record<string, unknown> | undefined;
      const value = outlets?.[name];
      return typeof value === "string" ? value : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "banned",
    category: "Core",
    description: "Placeholder for banned tokens — resolves to empty",
    returnType: "string",
    handler: () => "",
  });

  // ---- if / else / endif (scoped, with delayArgResolution) ----

  registry.registerMacro({
    builtIn: true,
    name: "if",
    category: "Core",
    description: "Conditional block. Usage: {{if::condition}}...{{else}}...{{/if}}",
    returnType: "string",
    delayArgResolution: true,
    handler: async (ctx) => {
      // Join multiple space-delimited args into one condition expression
      // e.g. {{if .myvar == 5}} → rawArgs = [[getvar], ["=="], ["5"]] → join with spaces
      let conditionNodes: any[] = ctx.rawArgs[0] || [];
      if (ctx.rawArgs.length > 1) {
        conditionNodes = [];
        for (let i = 0; i < ctx.rawArgs.length; i++) {
          if (i > 0) conditionNodes.push({ type: "text" as const, value: " " });
          conditionNodes.push(...ctx.rawArgs[i]);
        }
      }
      let conditionStr = (await ctx.resolveNodes(conditionNodes)).trim();

      // With recursive inline expansion, resolveNodes already fully expands
      // nested macros. One safety re-resolve covers the rare edge case where
      // a macro result depends on state mutated by a later macro in the same
      // template that hasn't been evaluated yet.
      if (conditionStr.includes("{{")) {
        const next = (await ctx.resolve(conditionStr)).trim();
        if (next !== conditionStr) conditionStr = next;
      }

      // Handle ! prefix negation (ST compat: {{if !condition}})
      let negate = false;
      if (conditionStr.startsWith("!")) {
        negate = true;
        conditionStr = conditionStr.slice(1).trim();
      }

      // Resolve remaining .var/$var shorthands that weren't caught by the lexer
      // (e.g. {{if !.myvar}} where ! prevented lexer shorthand detection)
      conditionStr = resolveInlineShorthands(conditionStr, ctx.env.variables);

      const isTruthy = evaluateCondition(conditionStr);
      const result = negate ? !isTruthy : isTruthy;

      if (ctx.isScoped) {
        const parts = splitOnElseNodes(ctx.bodyRaw);
        return await ctx.resolveNodes(result ? parts.truthy : parts.falsy);
      }

      return result ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "else",
    category: "Core",
    description: "Else branch for if blocks",
    returnType: "string",
    handler: () => ELSE_MARKER,
  });
}

/**
 * Resolve .varName and $varName shorthands within a condition string.
 * Used as a fallback when the lexer couldn't detect the shorthand
 * (e.g. preceded by ! or other non-space characters).
 */
function resolveInlineShorthands(
  condition: string,
  variables: { local: Map<string, string>; global: Map<string, string> },
): string {
  return condition
    .replace(/(^|\s)\.([a-zA-Z][\w-]*)/g, (_, pre, name) => pre + (variables.local.get(name) ?? ""))
    .replace(/(^|\s)\$([a-zA-Z][\w-]*)/g, (_, pre, name) => pre + (variables.global.get(name) ?? ""));
}

// Order matters here — we scan for the *leftmost* operator and prefer the
// longest match at that position so e.g. ">=" beats ">" when both could
// apply at index N.
const COMPARISON_OPERATORS = ["==", "!=", ">=", "<=", ">", "<"] as const;

function findComparisonOperator(value: string): { op: typeof COMPARISON_OPERATORS[number]; index: number } | null {
  let bestIndex = -1;
  let bestOp: typeof COMPARISON_OPERATORS[number] | null = null;
  for (const op of COMPARISON_OPERATORS) {
    const index = value.indexOf(op);
    if (index === -1) continue;
    if (bestIndex === -1 || index < bestIndex || (index === bestIndex && op.length > (bestOp?.length ?? 0))) {
      bestIndex = index;
      bestOp = op;
    }
  }
  return bestOp ? { op: bestOp, index: bestIndex } : null;
}

function evaluateCondition(value: string): boolean {
  // Unresolved macros (reconstructed as {{name}} by the evaluator) mean the
  // value couldn't be determined — treat the entire condition as falsy.
  if (value.includes("{{") && value.includes("}}")) {
    return false;
  }

  // Linear scan for the first comparison operator; avoids the previous
  // `^(.*?)\s*(...)\s*(.+)$` regex whose greedy/non-greedy combination
  // could backtrack pathologically on user-supplied values.
  const found = findComparisonOperator(value);
  if (found) {
    const lv = value.slice(0, found.index).trim();
    const rv = value.slice(found.index + found.op.length).trim();

    // Try numeric comparison
    const ln = parseFloat(lv);
    const rn = parseFloat(rv);
    const bothNumeric = !isNaN(ln) && !isNaN(rn);

    switch (found.op) {
      case "==": return bothNumeric ? ln === rn : lv === rv;
      case "!=": return bothNumeric ? ln !== rn : lv !== rv;
      case ">": return bothNumeric ? ln > rn : lv > rv;
      case ">=": return bothNumeric ? ln >= rn : lv >= rv;
      case "<": return bothNumeric ? ln < rn : lv < rv;
      case "<=": return bothNumeric ? ln <= rn : lv <= rv;
    }
  }

  // Falsy values
  if (!value || value === "0" || value === "false" || value === "null" || value === "undefined") {
    return false;
  }
  return true;
}

function splitOnElseNodes(body: AstNode[]): { truthy: AstNode[]; falsy: AstNode[] } {
  const idx = body.findIndex((node) => isElseNode(node));
  if (idx < 0) return { truthy: body, falsy: [] };
  return {
    truthy: body.slice(0, idx),
    falsy: body.slice(idx + 1),
  };
}

function isElseNode(node: AstNode): node is MacroNode {
  return node.type === "macro" && !node.flags.close && node.name.toLowerCase() === "else";
}

/** Strip leading/trailing blank lines, then remove common indentation. */
function dedent(text: string): string {
  const lines = text.split("\n");
  // Strip leading blank lines
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  // Strip trailing blank lines
  let end = lines.length - 1;
  while (end > start && lines[end].trim() === "") end--;
  const trimmed = lines.slice(start, end + 1);
  if (trimmed.length === 0) return "";
  const nonEmpty = trimmed.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  const minIndent = Math.min(
    ...nonEmpty.map((l) => {
      const m = l.match(/^(\s*)/);
      return m ? m[1].length : 0;
    }),
  );
  if (minIndent === 0) return trimmed.join("\n");
  return trimmed.map((l) => l.slice(minIndent)).join("\n");
}
