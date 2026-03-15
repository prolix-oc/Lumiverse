import { registry } from "../MacroRegistry";

export function registerVariableMacros(): void {
  // ---- Local Variables ----

  registry.registerMacro({
    builtIn: true,
    name: "getvar",
    category: "Variables",
    description: "Get a local (chat-scoped) variable value",
    returnType: "string",
    args: [{ name: "key", description: "Variable name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      return ctx.env.variables.local.get(key) ?? "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "setvar",
    category: "Variables",
    description: "Set a local variable (returns empty string)",
    returnType: "string",
    args: [
      { name: "key", description: "Variable name" },
      { name: "value", description: "Value to set" },
    ],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const value = ctx.isScoped ? ctx.body : (ctx.args[1] ?? "");
      ctx.env.variables.local.set(key, value);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "addvar",
    category: "Variables",
    description: "Add a numeric value to a local variable",
    returnType: "number",
    args: [
      { name: "key", description: "Variable name" },
      { name: "value", description: "Number to add" },
    ],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const addend = parseFloat(ctx.args[1]) || 0;
      const current = parseFloat(ctx.env.variables.local.get(key) || "0") || 0;
      const result = String(current + addend);
      ctx.env.variables.local.set(key, result);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "incvar",
    category: "Variables",
    description: "Increment a local variable by 1",
    returnType: "integer",
    args: [{ name: "key", description: "Variable name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const current = parseInt(ctx.env.variables.local.get(key) || "0", 10) || 0;
      const result = String(current + 1);
      ctx.env.variables.local.set(key, result);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "decvar",
    category: "Variables",
    description: "Decrement a local variable by 1",
    returnType: "integer",
    args: [{ name: "key", description: "Variable name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const current = parseInt(ctx.env.variables.local.get(key) || "0", 10) || 0;
      const result = String(current - 1);
      ctx.env.variables.local.set(key, result);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "hasvar",
    category: "Variables",
    description: "Check if a local variable exists (returns 'true' or 'false')",
    returnType: "boolean",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["varexists"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      return ctx.env.variables.local.has(key) ? "true" : "false";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "deletevar",
    category: "Variables",
    description: "Delete a local variable",
    returnType: "string",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["flushvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      ctx.env.variables.local.delete(key);
      return "";
    },
  });

  // ---- Global Variables ----

  registry.registerMacro({
    builtIn: true,
    name: "getgvar",
    category: "Variables",
    description: "Get a global variable value",
    returnType: "string",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["getglobalvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      return ctx.env.variables.global.get(key) ?? "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "setgvar",
    category: "Variables",
    description: "Set a global variable",
    returnType: "string",
    args: [
      { name: "key", description: "Variable name" },
      { name: "value", description: "Value to set" },
    ],
    aliases: ["setglobalvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const value = ctx.isScoped ? ctx.body : (ctx.args[1] ?? "");
      ctx.env.variables.global.set(key, value);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "addgvar",
    category: "Variables",
    description: "Add a numeric value to a global variable",
    returnType: "number",
    args: [
      { name: "key", description: "Variable name" },
      { name: "value", description: "Number to add" },
    ],
    aliases: ["addglobalvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const addend = parseFloat(ctx.args[1]) || 0;
      const current = parseFloat(ctx.env.variables.global.get(key) || "0") || 0;
      const result = String(current + addend);
      ctx.env.variables.global.set(key, result);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "incgvar",
    category: "Variables",
    description: "Increment a global variable by 1",
    returnType: "integer",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["incglobalvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const current = parseInt(ctx.env.variables.global.get(key) || "0", 10) || 0;
      const result = String(current + 1);
      ctx.env.variables.global.set(key, result);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "decgvar",
    category: "Variables",
    description: "Decrement a global variable by 1",
    returnType: "integer",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["decglobalvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const current = parseInt(ctx.env.variables.global.get(key) || "0", 10) || 0;
      const result = String(current - 1);
      ctx.env.variables.global.set(key, result);
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "hasgvar",
    category: "Variables",
    description: "Check if a global variable exists (returns 'true' or 'false')",
    returnType: "boolean",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["hasglobalvar", "gvarexists"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      return ctx.env.variables.global.has(key) ? "true" : "false";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "deletegvar",
    category: "Variables",
    description: "Delete a global variable",
    returnType: "string",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["flushgvar", "flushglobalvar", "deleteglobalvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      ctx.env.variables.global.delete(key);
      return "";
    },
  });
}
