import { registry } from "../MacroRegistry";
import type { AstNode, ScopedMacroNode } from "../types";
import { isConditionTruthy } from "../conditions";

export function registerLogicMacros(): void {
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "switch",
    category: "Logic",
    description:
      "Multi-branch conditional. {{switch::value::case1::result1::case2::result2::default}}",
    returnType: "string",
    isList: true,
    delayArgResolution: true,
    handler: async (ctx) => {
      const value = (await resolveArg(ctx, 0)).trim();
      if (ctx.isScoped && ctx.bodyRaw.length > 0) {
        return await resolveScopedSwitch(ctx, value);
      }

      // Args after the first come in case/result pairs; odd remainder is the default
      for (let i = 1; i + 1 < ctx.rawArgs.length; i += 2) {
        if ((await resolveArg(ctx, i)).trim() === value) {
          return await resolveArg(ctx, i + 1);
        }
      }
      // Default: last arg if odd count of remaining args
      const remaining = ctx.rawArgs.length - 1;
      if (remaining > 0 && remaining % 2 === 1) {
        return await resolveArg(ctx, ctx.rawArgs.length - 1);
      }
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "case",
    category: "Logic",
    description: "Case block marker for scoped {{switch}} blocks",
    returnType: "string",
    delayArgResolution: true,
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "default",
    category: "Logic",
    description: "Return the first truthy value, or the fallback",
    returnType: "string",
    delayArgResolution: true,
    args: [
      { name: "value", description: "Primary value" },
      { name: "fallback", description: "Fallback if value is falsy" },
    ],
    aliases: ["fallback", "coalesce"],
    handler: async (ctx) => {
      if (ctx.isScoped && ctx.rawArgs.length === 0) {
        return await ctx.resolveNodes(ctx.bodyRaw);
      }
      const value = await resolveArg(ctx, 0);
      if (isTruthy(value)) return value;
      return await resolveArg(ctx, 1);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "and",
    category: "Logic",
    description: "Logical AND — returns 'true' if all arguments are truthy, else ''",
    returnType: "boolean",
    isList: true,
    delayArgResolution: true,
    handler: async (ctx) => {
      if (ctx.rawArgs.length === 0) return "";
      for (let i = 0; i < ctx.rawArgs.length; i++) {
        if (!isTruthy(await resolveArg(ctx, i))) return "";
      }
      return "true";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "or",
    category: "Logic",
    description: "Logical OR — returns 'true' if any argument is truthy, else ''",
    returnType: "boolean",
    isList: true,
    delayArgResolution: true,
    handler: async (ctx) => {
      if (ctx.rawArgs.length === 0) return "";
      for (let i = 0; i < ctx.rawArgs.length; i++) {
        if (isTruthy(await resolveArg(ctx, i))) return "true";
      }
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "not",
    category: "Logic",
    description: "Logical NOT — returns 'true' if value is falsy, else ''",
    returnType: "boolean",
    args: [{ name: "value", description: "Value to negate" }],
    handler: (ctx) => {
      return isTruthy(ctx.args[0] ?? "") ? "" : "true";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "empty",
    category: "Logic",
    description: "Returns 'true' when the value is exactly empty",
    returnType: "boolean",
    aliases: ["isEmpty"],
    args: [{ name: "value", description: "Value to test" }],
    handler: (ctx) => (ctx.args[0] ?? "") === "" ? "true" : "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "blank",
    category: "Logic",
    description: "Returns 'true' when the value is empty or whitespace-only",
    returnType: "boolean",
    aliases: ["isBlank"],
    args: [{ name: "value", description: "Value to test" }],
    handler: (ctx) => (ctx.args[0] ?? "").trim() === "" ? "true" : "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "number",
    category: "Logic",
    description: "Returns 'true' when the value is a finite number",
    returnType: "boolean",
    aliases: ["isNumber", "numeric"],
    args: [{ name: "value", description: "Value to test" }],
    handler: (ctx) => {
      const value = (ctx.args[0] ?? "").trim();
      return value !== "" && Number.isFinite(Number(value)) ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "integer",
    category: "Logic",
    description: "Returns 'true' when the value is an integer",
    returnType: "boolean",
    aliases: ["isInteger", "int"],
    args: [{ name: "value", description: "Value to test" }],
    handler: (ctx) => {
      const value = (ctx.args[0] ?? "").trim();
      return /^[-+]?\d+$/.test(value) ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "matches",
    category: "Logic",
    description: "Returns 'true' when text matches a regular expression",
    returnType: "boolean",
    args: [
      { name: "text", description: "Text to test" },
      { name: "pattern", description: "Regular expression pattern" },
      { name: "flags", optional: true, description: "Regex flags" },
    ],
    handler: (ctx) => {
      try {
        return new RegExp(ctx.args[1] ?? "", ctx.args[2] ?? "").test(ctx.args[0] ?? "") ? "true" : "";
      } catch {
        return "";
      }
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "startsWith",
    category: "Logic",
    description: "Returns 'true' when text starts with prefix",
    returnType: "boolean",
    aliases: ["starts_with"],
    args: [
      { name: "text", description: "Text to test" },
      { name: "prefix", description: "Prefix" },
    ],
    handler: (ctx) => (ctx.args[0] ?? "").startsWith(ctx.args[1] ?? "") ? "true" : "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "endsWith",
    category: "Logic",
    description: "Returns 'true' when text ends with suffix",
    returnType: "boolean",
    aliases: ["ends_with"],
    args: [
      { name: "text", description: "Text to test" },
      { name: "suffix", description: "Suffix" },
    ],
    handler: (ctx) => (ctx.args[0] ?? "").endsWith(ctx.args[1] ?? "") ? "true" : "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "eq",
    category: "Logic",
    description: "Equality check — returns 'true' if a == b (numeric-aware)",
    returnType: "boolean",
    args: [
      { name: "a", description: "Left value" },
      { name: "b", description: "Right value" },
    ],
    handler: (ctx) => {
      const a = (ctx.args[0] ?? "").trim();
      const b = (ctx.args[1] ?? "").trim();
      const na = parseFloat(a);
      const nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na === nb ? "true" : "";
      return a === b ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "ne",
    category: "Logic",
    description: "Inequality check — returns 'true' if a != b",
    returnType: "boolean",
    args: [
      { name: "a", description: "Left value" },
      { name: "b", description: "Right value" },
    ],
    handler: (ctx) => {
      const a = (ctx.args[0] ?? "").trim();
      const b = (ctx.args[1] ?? "").trim();
      const na = parseFloat(a);
      const nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na !== nb ? "true" : "";
      return a !== b ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "gt",
    category: "Logic",
    description: "Greater-than check — returns 'true' if a > b",
    returnType: "boolean",
    args: [
      { name: "a", description: "Left value" },
      { name: "b", description: "Right value" },
    ],
    handler: (ctx) => {
      const a = parseFloat(ctx.args[0]);
      const b = parseFloat(ctx.args[1]);
      return !isNaN(a) && !isNaN(b) && a > b ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "lt",
    category: "Logic",
    description: "Less-than check — returns 'true' if a < b",
    returnType: "boolean",
    args: [
      { name: "a", description: "Left value" },
      { name: "b", description: "Right value" },
    ],
    handler: (ctx) => {
      const a = parseFloat(ctx.args[0]);
      const b = parseFloat(ctx.args[1]);
      return !isNaN(a) && !isNaN(b) && a < b ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "gte",
    category: "Logic",
    description: "Greater-than-or-equal check — returns 'true' if a >= b",
    returnType: "boolean",
    args: [
      { name: "a", description: "Left value" },
      { name: "b", description: "Right value" },
    ],
    handler: (ctx) => {
      const a = parseFloat(ctx.args[0]);
      const b = parseFloat(ctx.args[1]);
      return !isNaN(a) && !isNaN(b) && a >= b ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "lte",
    category: "Logic",
    description: "Less-than-or-equal check — returns 'true' if a <= b",
    returnType: "boolean",
    args: [
      { name: "a", description: "Left value" },
      { name: "b", description: "Right value" },
    ],
    handler: (ctx) => {
      const a = parseFloat(ctx.args[0]);
      const b = parseFloat(ctx.args[1]);
      return !isNaN(a) && !isNaN(b) && a <= b ? "true" : "";
    },
  });
}

function isTruthy(value: string): boolean {
  return isConditionTruthy(value.trim());
}

async function resolveArg(
  ctx: { rawArgs: import("../types").AstNode[][]; resolveNodes: (nodes: import("../types").AstNode[]) => string | Promise<string> },
  index: number,
): Promise<string> {
  const nodes = ctx.rawArgs[index] ?? [];
  return String(await Promise.resolve(ctx.resolveNodes(nodes)));
}

async function resolveScopedSwitch(
  ctx: {
    bodyRaw: AstNode[];
    resolveNodes: (nodes: AstNode[]) => string | Promise<string>;
  },
  value: string,
): Promise<string> {
  let defaultBody: AstNode[] | null = null;

  for (const node of ctx.bodyRaw) {
    if (node.type !== "scoped_macro") continue;
    const scoped = node as ScopedMacroNode;
    const name = scoped.name.toLowerCase();

    if (name === "case") {
      for (const arg of scoped.args) {
        if ((await ctx.resolveNodes(arg)).trim() === value) {
          return String(await Promise.resolve(ctx.resolveNodes(scoped.body)));
        }
      }
      continue;
    }

    if (name === "default") {
      defaultBody = scoped.body;
    }
  }

  return defaultBody ? String(await Promise.resolve(ctx.resolveNodes(defaultBody))) : "";
}
