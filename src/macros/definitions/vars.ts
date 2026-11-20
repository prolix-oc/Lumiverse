import { registry } from "../MacroRegistry";
import type { MacroArgDef, MacroExecContext } from "../types";
import { readJsonInput } from "../json-blocks";
import {
  MALFORMED_JSON_VALUE_WARNING,
  deleteJsonPath,
  formatJsonRead,
  getJsonPath,
  jsonTypeName,
  parseJsonDocument,
  parseJsonPath,
  parseJsonWriteValue,
  serializeJsonDocument,
  setJsonPath,
  type JsonPathSegment,
  type JsonValue,
} from "../json-utils";

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
      if (!key) return "";
      // Explicit local variable lookup only. We do NOT fall back to evaluating
      // the key as a macro — that allowed character/world-info content to
      // smuggle macro side effects via keys like "setvar::foo::pwn", silently
      // mutating variables on lookup.
      return ctx.env.variables.local.has(key)
        ? ctx.env.variables.local.get(key)!
        : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
    terminal: true,
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
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
    terminal: true,
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

  registry.registerMacro({
    builtIn: true,
    name: "let",
    category: "Variables",
    description:
      "Temporarily bind local variables for a scoped body, then restore previous values. " +
      "Usage: {{let::name::value::other::value}}...{{/let}}.",
    returnType: "string",
    delayArgResolution: true,
    aliases: ["withVar", "scope"],
    handler: runLetMacro,
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
      if (!key) return "";
      return ctx.env.variables.global.has(key)
        ? ctx.env.variables.global.get(key)!
        : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
    terminal: true,
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
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
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
    terminal: true,
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

  // ---- Chat-Scoped Persisted Variables ----

  registry.registerMacro({
    builtIn: true,
    name: "getchatvar",
    category: "Variables",
    description: "Get a chat-scoped persisted variable value",
    returnType: "string",
    args: [{ name: "key", description: "Variable name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      if (!key) return "";
      return ctx.env.variables.chat.has(key)
        ? ctx.env.variables.chat.get(key)!
        : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "setchatvar",
    category: "Variables",
    description: "Set a chat-scoped persisted variable (persists across generations)",
    returnType: "string",
    args: [
      { name: "key", description: "Variable name" },
      { name: "value", description: "Value to set" },
    ],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const value = ctx.isScoped ? ctx.body : (ctx.args[1] ?? "");
      ctx.env.variables.chat.set(key, value);
      ctx.env._chatVarsDirty = true;
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "addchatvar",
    category: "Variables",
    description: "Add a numeric value to a chat-scoped persisted variable",
    returnType: "number",
    args: [
      { name: "key", description: "Variable name" },
      { name: "value", description: "Number to add" },
    ],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const addend = parseFloat(ctx.args[1]) || 0;
      const current = parseFloat(ctx.env.variables.chat.get(key) || "0") || 0;
      const result = String(current + addend);
      ctx.env.variables.chat.set(key, result);
      ctx.env._chatVarsDirty = true;
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "incchatvar",
    category: "Variables",
    description: "Increment a chat-scoped persisted variable by 1",
    returnType: "integer",
    args: [{ name: "key", description: "Variable name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const current = parseInt(ctx.env.variables.chat.get(key) || "0", 10) || 0;
      const result = String(current + 1);
      ctx.env.variables.chat.set(key, result);
      ctx.env._chatVarsDirty = true;
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "decchatvar",
    category: "Variables",
    description: "Decrement a chat-scoped persisted variable by 1",
    returnType: "integer",
    args: [{ name: "key", description: "Variable name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      const current = parseInt(ctx.env.variables.chat.get(key) || "0", 10) || 0;
      const result = String(current - 1);
      ctx.env.variables.chat.set(key, result);
      ctx.env._chatVarsDirty = true;
      return result;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "haschatvar",
    category: "Variables",
    description: "Check if a chat-scoped persisted variable exists (returns 'true' or 'false')",
    returnType: "boolean",
    args: [{ name: "key", description: "Variable name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      return ctx.env.variables.chat.has(key) ? "true" : "false";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "deletechatvar",
    category: "Variables",
    description: "Delete a chat-scoped persisted variable",
    returnType: "string",
    args: [{ name: "key", description: "Variable name" }],
    aliases: ["flushchatvar"],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      ctx.env.variables.chat.delete(key);
      ctx.env._chatVarsDirty = true;
      return "";
    },
  });

  // ---- JSON paths inside variables (local, chat, global) ----

  registerVariablePathMacros();
}

async function runLetMacro(ctx: MacroExecContext): Promise<string> {
  if (!ctx.isScoped) {
    ctx.warn("{{let}} needs a body: {{let::name::value}}...{{/let}}");
    return "";
  }

  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < ctx.rawArgs.length; i += 2) {
    const key = (await ctx.resolveNodes(ctx.rawArgs[i])).trim();
    if (!key) continue;
    const value = await ctx.resolveNodes(ctx.rawArgs[i + 1]);
    pairs.push([key, value]);
  }

  if (pairs.length === 0) return await ctx.resolveNodes(ctx.bodyRaw);

  const local = ctx.env.variables.local;
  const saved = new Map<string, string | undefined>();
  for (const [key] of pairs) {
    if (!saved.has(key)) saved.set(key, local.has(key) ? local.get(key) : undefined);
  }

  try {
    for (const [key, value] of pairs) {
      local.set(key, value);
    }
    return await ctx.resolveNodes(ctx.bodyRaw);
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) local.delete(key);
      else local.set(key, previous);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON paths inside variables
//
//   {{setchatvarkey::state::party[0].hp::12}} … {{getchatvarkey::state::party[0].hp}}
//
// These are separate macros rather than a path argument on the plain getters:
// variable shorthand such as {{@hp || 0}} compiles to getchatvar with the
// operand as a second argument, which the getters must keep ignoring.
// ---------------------------------------------------------------------------

type VarScope = "local" | "chat" | "global";
type VarPathOp = "get" | "set" | "add" | "has" | "delete";

const VAR_PATH_SCOPES: readonly {
  scope: VarScope;
  /** Name stem of the plain macros: get<stem>key sits beside get<stem>. */
  stem: string;
  label: string;
  aliases: Partial<Record<VarPathOp, string[]>>;
}[] = [
  { scope: "local", stem: "var", label: "local", aliases: { get: ["getvarindex"], set: ["setvarindex"] } },
  { scope: "chat", stem: "chatvar", label: "chat-scoped persisted", aliases: {} },
  {
    scope: "global",
    stem: "gvar",
    label: "global",
    aliases: {
      get: ["getglobalvarkey", "getglobalvarindex"],
      set: ["setglobalvarkey", "setglobalvarindex"],
      add: ["addglobalvarkey"],
      has: ["hasglobalvarkey"],
      delete: ["deleteglobalvarkey"],
    },
  },
];

function registerVariablePathMacros(): void {
  const keyArg: MacroArgDef = { name: "key", description: "Variable name" };
  const pathDescription = 'Path inside the JSON value, e.g. party[0].name, items[-1] or ["key.with.dots"]';
  const pathArg: MacroArgDef = { name: "path", description: pathDescription };

  for (const { scope, stem, label, aliases } of VAR_PATH_SCOPES) {
    registry.registerMacro({
      builtIn: true,
      terminal: true,
      name: `get${stem}key`,
      category: "Variables",
      description:
        `Read a value by path from a ${label} variable holding JSON. Text comes back as written, ` +
        `objects and arrays as JSON; a missing variable or path gives an empty result. ` +
        `Usage: {{get${stem}key::state::party[0].name}}`,
      returnType: "string",
      args: [keyArg, { name: "path", optional: true, description: `${pathDescription}; omit for the whole value` }],
      aliases: aliases.get ?? [],
      handler: (ctx) => getVarPath(ctx, scope),
    });

    registry.registerMacro({
      builtIn: true,
      terminal: true,
      name: `set${stem}key`,
      category: "Variables",
      description:
        `Write a value by path into a ${label} variable holding JSON, creating the variable and any ` +
        `missing objects or arrays ([] appends). A value that parses as JSON is stored as JSON, anything ` +
        `else as a string. Usage: {{set${stem}key::state::party[0].hp::10}} or ` +
        `{{set${stem}key::state::bio}}text{{/set${stem}key}}`,
      returnType: "string",
      args: [keyArg, pathArg, { name: "value", optional: true, description: "Value to write (or use the scoped body)" }],
      aliases: aliases.set ?? [],
      handler: (ctx) => setVarPath(ctx, scope),
    });

    registry.registerMacro({
      builtIn: true,
      terminal: true,
      name: `add${stem}key`,
      category: "Variables",
      description:
        `Add a number to the value at a path in a ${label} variable holding JSON; a missing or null ` +
        `value starts at 0. Returns the new value.`,
      returnType: "number",
      args: [keyArg, pathArg, { name: "value", description: "Number to add" }],
      aliases: aliases.add ?? [],
      handler: (ctx) => addVarPath(ctx, scope),
    });

    registry.registerMacro({
      builtIn: true,
      terminal: true,
      name: `has${stem}key`,
      category: "Variables",
      description: `Check whether a path exists in a ${label} variable holding JSON (returns 'true' or 'false')`,
      returnType: "boolean",
      args: [keyArg, pathArg],
      aliases: aliases.has ?? [],
      handler: (ctx) => hasVarPath(ctx, scope),
    });

    registry.registerMacro({
      builtIn: true,
      terminal: true,
      name: `delete${stem}key`,
      category: "Variables",
      description: `Delete the value at a path in a ${label} variable holding JSON (array items are spliced out)`,
      returnType: "string",
      args: [keyArg, pathArg],
      aliases: aliases.delete ?? [],
      handler: (ctx) => deleteVarPath(ctx, scope),
    });
  }
}

interface VarDocument {
  name: string;
  path: JsonPathSegment[];
  /** The path as written, for messages. */
  pathText: string;
  /** The stored text, so a write that changes nothing is skipped. */
  stored: string | undefined;
  value: JsonValue | undefined;
}

function warnMacro(ctx: MacroExecContext, message: string): void {
  ctx.warn(`{{${ctx.name}}}: ${message}`);
}

/**
 * Resolve the name and path arguments and parse the variable. A missing or
 * blank variable is "no document"; one that is not JSON is never overwritten.
 * Warns and returns null when anything is unusable.
 */
function openVarDocument(ctx: MacroExecContext, scope: VarScope, op: VarPathOp): VarDocument | null {
  const name = (ctx.args[0] || "").trim();
  if (!name) {
    warnMacro(ctx, "needs a variable name");
    return null;
  }
  const pathText = readJsonInput(ctx.args[1] || "", ctx.env).trim();
  const path = parseJsonPath(pathText, { allowAppend: op === "set" || op === "add" });
  if (!path.ok) {
    warnMacro(ctx, `invalid path "${pathText}": ${path.error}`);
    return null;
  }
  const stored = ctx.env.variables[scope].get(name);
  const doc = parseJsonDocument(readJsonInput(stored ?? "", ctx.env));
  if (!doc.ok) {
    const outcome = op === "get" || op === "has" ? "" : "; it was left unchanged";
    warnMacro(ctx, `${scope} variable "${name}" cannot be read as JSON: ${doc.error}${outcome}`);
    return null;
  }
  return { name, path: path.value, pathText, stored, value: doc.value };
}

/** Store an edited document. Identical text is not rewritten, so only a real chat write marks chat vars dirty. */
function storeVarDocument(ctx: MacroExecContext, scope: VarScope, doc: VarDocument, value: JsonValue): boolean {
  const text = serializeJsonDocument(value);
  if (!text.ok) {
    warnMacro(ctx, `${text.error}; ${scope} variable "${doc.name}" was left unchanged`);
    return false;
  }
  if (text.value !== doc.stored) {
    ctx.env.variables[scope].set(doc.name, text.value);
    if (scope === "chat") ctx.env._chatVarsDirty = true;
  }
  return true;
}

function getVarPath(ctx: MacroExecContext, scope: VarScope): string {
  const doc = openVarDocument(ctx, scope, "get");
  if (!doc) return "";
  const hit = getJsonPath(doc.value, doc.path);
  return hit.found ? formatJsonRead(hit.value) : "";
}

function setVarPath(ctx: MacroExecContext, scope: VarScope): string {
  const doc = openVarDocument(ctx, scope, "set");
  if (!doc) return "";
  const unchanged = `; ${scope} variable "${doc.name}" was left unchanged`;
  const typed = parseJsonWriteValue(readJsonInput(ctx.isScoped ? ctx.body : (ctx.args[2] ?? ""), ctx.env));
  if (!typed.ok) {
    warnMacro(ctx, `${typed.error}${unchanged}`);
    return "";
  }
  if (typed.value.malformedJson) warnMacro(ctx, MALFORMED_JSON_VALUE_WARNING);
  const updated = setJsonPath(doc.value, doc.path, typed.value.value);
  if (!updated.ok) {
    warnMacro(ctx, `cannot set "${doc.pathText}": ${updated.error}${unchanged}`);
    return "";
  }
  storeVarDocument(ctx, scope, doc, updated.value);
  return "";
}

function addVarPath(ctx: MacroExecContext, scope: VarScope): string {
  const doc = openVarDocument(ctx, scope, "add");
  if (!doc) return "";
  const unchanged = `; ${scope} variable "${doc.name}" was left unchanged`;
  const addendText = (ctx.args[2] || "").trim();
  // Number("") is 0, but a missing addend is a mistake rather than "add nothing".
  const addend = addendText === "" ? NaN : Number(addendText);
  if (!Number.isFinite(addend)) {
    warnMacro(ctx, `"${addendText}" is not a finite number${unchanged}`);
    return "";
  }
  const current = getJsonPath(doc.value, doc.path);
  const base = current.found ? current.value : null;
  if (base !== null && typeof base !== "number") {
    warnMacro(ctx, `"${doc.pathText}" holds ${jsonTypeName(base)}, not a number${unchanged}`);
    return "";
  }
  const sum = (base ?? 0) + addend;
  if (!Number.isFinite(sum)) {
    warnMacro(ctx, `the sum is not a finite number${unchanged}`);
    return "";
  }
  const updated = setJsonPath(doc.value, doc.path, sum);
  if (!updated.ok) {
    warnMacro(ctx, `cannot set "${doc.pathText}": ${updated.error}${unchanged}`);
    return "";
  }
  return storeVarDocument(ctx, scope, doc, updated.value) ? String(sum) : "";
}

function hasVarPath(ctx: MacroExecContext, scope: VarScope): string {
  const doc = openVarDocument(ctx, scope, "has");
  return doc && getJsonPath(doc.value, doc.path).found ? "true" : "false";
}

function deleteVarPath(ctx: MacroExecContext, scope: VarScope): string {
  const doc = openVarDocument(ctx, scope, "delete");
  if (!doc) return "";
  const removed = deleteJsonPath(doc.value, doc.path);
  if (!removed.ok) warnMacro(ctx, `${removed.error}; ${scope} variable "${doc.name}" was left unchanged`);
  else if (removed.value && doc.value !== undefined) storeVarDocument(ctx, scope, doc, doc.value);
  return "";
}
