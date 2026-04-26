import { registry } from "../MacroRegistry";

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
    handler: (ctx) => {
      const value = (ctx.args[0] ?? "").trim();
      // Args after the first come in case/result pairs; odd remainder is the default
      for (let i = 1; i + 1 < ctx.args.length; i += 2) {
        if ((ctx.args[i] ?? "").trim() === value) {
          return ctx.args[i + 1] ?? "";
        }
      }
      // Default: last arg if odd count of remaining args
      const remaining = ctx.args.length - 1;
      if (remaining > 0 && remaining % 2 === 1) {
        return ctx.args[ctx.args.length - 1] ?? "";
      }
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "default",
    category: "Logic",
    description: "Return the first truthy value, or the fallback",
    returnType: "string",
    args: [
      { name: "value", description: "Primary value" },
      { name: "fallback", description: "Fallback if value is falsy" },
    ],
    aliases: ["fallback", "coalesce"],
    handler: (ctx) => {
      const value = ctx.args[0] ?? "";
      if (isTruthy(value)) return value;
      return ctx.args[1] ?? "";
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
    handler: (ctx) => {
      if (ctx.args.length === 0) return "";
      return ctx.args.every((a) => isTruthy(a)) ? "true" : "";
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
    handler: (ctx) => {
      if (ctx.args.length === 0) return "";
      return ctx.args.some((a) => isTruthy(a)) ? "true" : "";
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
  if (!value) return false;
  const v = value.trim();
  return v !== "" && v !== "0" && v !== "false" && v !== "null" && v !== "undefined";
}
