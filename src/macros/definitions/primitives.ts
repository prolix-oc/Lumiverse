import type { AstNode, MacroNode } from "../types";
import { registry } from "../MacroRegistry";
import { evaluateMacroCondition } from "../conditions";

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
    name: "persona_outlet",
    category: "Core",
    description: "Resolve an enabled persona add-on outlet by name",
    returnType: "string",
    args: [{ name: "name", description: "Outlet name configured on a persona add-on" }],
    aliases: ["personaOutlet"],
    handler: (ctx) => {
      const name = (ctx.args[0] || "").trim().toLowerCase();
      if (!name) return "";
      const outlets = ctx.env.extra?.personaAddonOutlets as Record<string, unknown> | undefined;
      const value = outlets?.[name];
      return typeof value === "string" ? value : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "wi_marker",
    category: "Core",
    description:
      "Resolve all activated world-info entries set to 'At Marker' position, joined by double newlines",
    returnType: "string",
    handler: (ctx) => {
      const pool = ctx.env.extra?.worldInfoAtMarker as string | undefined;
      return typeof pool === "string" ? pool : "";
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
    description: "Conditional block. Usage: {{if::condition}}...{{elseif::other}}...{{else}}...{{/if}}",
    returnType: "string",
    delayArgResolution: true,
    handler: async (ctx) => {
      const result = await conditionIsTruthy(ctx, conditionArgNodes(ctx.rawArgs));

      if (ctx.isScoped) {
        const branches = splitConditionalBranches(ctx.bodyRaw);
        if (result) {
          return await ctx.resolveNodes(branches[0]?.body ?? ctx.bodyRaw);
        }
        for (const branch of branches.slice(1)) {
          if (!branch.condition) return await ctx.resolveNodes(branch.body);
          if (await conditionIsTruthy(ctx, branch.condition)) {
            return await ctx.resolveNodes(branch.body);
          }
        }
        return "";
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

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "elseif",
    category: "Core",
    description: "Else-if marker for {{if}} blocks",
    returnType: "string",
    aliases: ["elif"],
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    name: "unless",
    category: "Core",
    description: "Inverse conditional block. Usage: {{unless::condition}}...{{else}}...{{/unless}}",
    returnType: "string",
    delayArgResolution: true,
    handler: async (ctx) => {
      const result = await conditionIsTruthy(ctx, conditionArgNodes(ctx.rawArgs));
      if (!ctx.isScoped) return result ? "" : "true";

      const parts = splitOnElseNodes(ctx.bodyRaw);
      return await ctx.resolveNodes(result ? parts.falsy : parts.truthy);
    },
  });
}

function conditionArgNodes(rawArgs: AstNode[][]): AstNode[] {
  // Join multiple space-delimited args into one condition expression:
  // {{if .myvar == 5}} -> [[getvar], ["=="], ["5"]] -> ".myvar == 5"
  if (rawArgs.length <= 1) return rawArgs[0] ?? [];
  const nodes: AstNode[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (i > 0) nodes.push({ type: "text", value: " " });
    nodes.push(...rawArgs[i]);
  }
  return nodes;
}

async function conditionIsTruthy(
  ctx: {
    resolve: (text: string) => string | Promise<string>;
    resolveNodes: (nodes: AstNode[]) => string | Promise<string>;
    env: { variables: Parameters<typeof evaluateMacroCondition>[1] };
  },
  nodes: AstNode[],
): Promise<boolean> {
  let conditionStr = (await ctx.resolveNodes(nodes)).trim();

  // With recursive inline expansion, resolveNodes already fully expands nested
  // macros. One safety re-resolve covers the rare edge case where a macro
  // result depends on state mutated later in the same template.
  if (conditionStr.includes("{{")) {
    const next = (await ctx.resolve(conditionStr)).trim();
    if (next !== conditionStr) conditionStr = next;
  }

  return evaluateMacroCondition(conditionStr, ctx.env.variables);
}

type ConditionalBranch = {
  condition: AstNode[] | null;
  body: AstNode[];
};

function splitConditionalBranches(body: AstNode[]): ConditionalBranch[] {
  const branches: ConditionalBranch[] = [{ condition: null, body: [] }];

  for (const node of body) {
    if (node.type === "macro" && !node.flags.close) {
      const name = node.name.toLowerCase();
      if (name === "elseif" || name === "elif") {
        branches.push({ condition: conditionArgNodes(node.args), body: [] });
        continue;
      }
      if (name === "else") {
        branches.push({ condition: null, body: [] });
        continue;
      }
    }
    branches[branches.length - 1]!.body.push(node);
  }

  return branches;
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
