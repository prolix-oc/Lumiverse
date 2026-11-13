import { stripArgFraming } from "../MacroEvaluator";
import { registry } from "../MacroRegistry";
import type { AstNode, MacroArgDef, MacroEnv, MacroExecContext, MacroNode } from "../types";
import { findJsonBlocks, readJsonInput } from "../json-blocks";
import { formatList, MAX_LIST_ITEMS, resolveIndex } from "../list-utils";
import {
  MALFORMED_JSON_VALUE_WARNING,
  MAX_JSON_TEXT_LENGTH,
  deleteJsonPath,
  escapeJsonString,
  formatJsonRead,
  getJsonPath,
  hasNonFiniteNumber,
  isJsonObject,
  parseJsonDocument,
  parseJsonPath,
  parseJsonWriteValue,
  serializeJsonDocument,
  setJsonPath,
  shieldDataBraces,
  shieldJsonStrings,
  trySerializeJson,
  type JsonLookup,
  type JsonPathSegment,
  type JsonResult,
  type JsonValue,
} from "../json-utils";

/**
 * JSON family — read and edit JSON text by path. Each macro takes JSON text as
 * its first argument and returns text: reads give plain values, edits give
 * compact JSON whose string braces are escaped, so no later macro pass can
 * execute what was data.
 *
 * Inside a `::` argument the first `}}` closes the macro and `::` starts the
 * next argument, so nested JSON travels through a scoped body or a variable:
 *   {{setchatvar::state}}{"party":[{"hp":3}]}{{/setchatvar}}
 *   {{jsonGet::{{getchatvar::state}}::party[0].hp}}
 *
 * The macros resolve their own arguments, so a source that names stored data,
 * as {{getchatvar::state}} does above, is read without being expanded.
 */

const WHOLE_NUMBER_RE = /^-?\d+$/;
const BLANK_RE = /^\s*$/;

const JSON_ARG: MacroArgDef = { name: "json", description: "JSON text, e.g. {{getchatvar::state}}" };
const PATH_DESCRIPTION = 'Path such as party[0].name, items[-1] or ["key.with.dots"]';
const PATH_ARG: MacroArgDef = { name: "path", description: PATH_DESCRIPTION };
const OPTIONAL_PATH_ARG: MacroArgDef = {
  name: "path",
  optional: true,
  description: `${PATH_DESCRIPTION}; omit for the whole value`,
};

/**
 * Macros that return stored data, a variable or a chat message, rather than
 * template text. Resolved normally, that output is expanded again, which runs
 * macro text stored inside JSON strings, so a JSON source that is one call to
 * such a macro reads the data directly. Each reader gets every resolved
 * argument and, like the macro's handler, uses only the ones the handler
 * reads: a getter's key is its first argument, so an operand that shorthand
 * such as `{{@state || 0}}` passes as a second argument changes nothing. Keep
 * each reader in step with the handler.
 */
const DATA_MACROS: Record<string, (env: MacroEnv, args: readonly string[]) => string> = {
  getvar: (env, [key = ""]) => readVariable(env.variables.local, key),
  getchatvar: (env, [key = ""]) => readVariable(env.variables.chat, key),
  getgvar: (env, [key = ""]) => readVariable(env.variables.global, key),
  messageAt: (env, [index = ""]) => readMessageAt(env, index),
  lastMessage: (env) => env.chat.lastMessage,
  lastUserMessage: (env) => env.chat.lastUserMessage,
  lastCharMessage: (env) => env.chat.lastCharMessage,
  rejectedSwipe: (env) => env.chat.rejectedSwipe,
  input: (env) => env.chat.lastUserMessage,
  loomLastUserMessage: (env) => env.chat.lastUserMessage,
  loomLastCharMessage: (env) => env.chat.lastCharMessage,
};

/** The getters' lookup: the key is trimmed, and a blank key reads nothing. */
function readVariable(variables: Map<string, string>, key: string): string {
  const name = key.trim();
  if (!name) return "";
  const value = variables.get(name);
  // Persisted chat state can hold null, which the getter's output stringifies too.
  return value === undefined ? "" : String(value);
}

/** {{messageAt}}'s lookup: an index that does not parse, or none, is 0, and a negative one counts from the end. */
function readMessageAt(env: MacroEnv, indexText: string): string {
  const messages: readonly { content?: string }[] = Array.isArray(env.extra.messages) ? env.extra.messages : [];
  let index = parseInt(indexText, 10) || 0;
  if (index < 0) index += messages.length;
  return messages[index]?.content ?? "";
}

/**
 * Resolve the arguments in order, each the way the evaluator resolves an eager
 * argument, except that a JSON source (the first) holding one call to a data
 * macro reads that data unexpanded.
 */
async function resolveJsonArgs(ctx: MacroExecContext): Promise<string[]> {
  const sourceNodes = stripArgFraming(ctx.rawArgs[0] ?? []);
  const args = [(await readStoredData(ctx, sourceNodes)) ?? (await ctx.resolveNodes(sourceNodes))];
  for (let i = 1; i < ctx.rawArgs.length; i++) {
    args.push(await ctx.resolveNodes(stripArgFraming(ctx.rawArgs[i])));
  }
  return args;
}

/**
 * The text of a source that is one call to a data macro, with any blank text
 * around the call kept, read without expanding the data. Undefined for any
 * other source.
 */
async function readStoredData(ctx: MacroExecContext, nodes: AstNode[]): Promise<string | undefined> {
  let call: MacroNode | undefined;
  for (const node of nodes) {
    if (node.type === "text" && BLANK_RE.test(node.value)) continue;
    if (node.type !== "macro" || call) return undefined;
    call = node;
  }
  if (!call) return undefined;
  const name = registry.getMacro(call.name)?.name ?? "";
  const read = Object.hasOwn(DATA_MACROS, name) ? DATA_MACROS[name] : undefined;
  if (!read) return undefined;

  // Every argument resolves in order, as the evaluator resolves the call's
  // eager arguments, so one the reader ignores still has its side effects.
  const args: string[] = [];
  for (const arg of call.args) args.push(await ctx.resolveNodes(stripArgFraming(arg)));
  const data = read(ctx.env, args);
  let text = "";
  for (const node of nodes) text += node.type === "text" ? node.value : data;
  return text;
}

function warn(ctx: MacroExecContext, message: string): void {
  ctx.warn(`{{${ctx.name}}}: ${message}`);
}

/** Parse the JSON source, warning when it is not JSON. */
function readDocument(ctx: MacroExecContext, source: string): JsonResult<JsonValue | undefined> {
  const doc = parseJsonDocument(readJsonInput(source, ctx.env));
  if (!doc.ok) warn(ctx, doc.error);
  return doc;
}

/** Parse a path read through `readJsonInput`, warning when it is not a valid path. */
function readPath(ctx: MacroExecContext, text: string, allowAppend = false): JsonResult<JsonPathSegment[]> {
  const path = parseJsonPath(text, { allowAppend });
  if (!path.ok) warn(ctx, `invalid path "${text}": ${path.error}`);
  return path;
}

/** Look a path up in the JSON source; null (after a warning) when either is unusable. */
function lookUp(ctx: MacroExecContext, source: string, pathArg: string): JsonLookup | null {
  const doc = readDocument(ctx, source);
  const path = readPath(ctx, readJsonInput(pathArg, ctx.env).trim());
  return doc.ok && path.ok ? getJsonPath(doc.value, path.value) : null;
}

/**
 * The JSON source as the result when a macro cannot use it or has nothing to
 * change. A source read straight from a variable or message was never
 * expanded, so it may hold macro text or a legacy tag such as `<user>`. Valid
 * JSON, as the macro read it, keeps its own formatting with `{`, `}` and `<`
 * in its strings escaped like written JSON; anything else gets its braces
 * shielded like other data the macros return.
 */
function unchanged(ctx: MacroExecContext, source: string, doc: JsonResult<JsonValue | undefined>): string {
  return doc.ok ? shieldJsonStrings(readJsonInput(source, ctx.env)) : shieldDataBraces(source);
}

export function registerJsonMacros(): void {
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonGet",
    category: "JSON",
    description:
      "Read a value from JSON by path. Text comes back as written, numbers and booleans as-is, " +
      "objects and arrays as compact JSON; null, a missing path, or invalid JSON give an empty result. " +
      "Usage: {{jsonGet::{{getchatvar::state}}::party[0].name}}",
    returnType: "string",
    args: [JSON_ARG, OPTIONAL_PATH_ARG],
    delayArgResolution: true,
    aliases: ["json_get"],
    handler: async (ctx) => {
      const [source, pathArg = ""] = await resolveJsonArgs(ctx);
      const hit = lookUp(ctx, source, pathArg);
      if (!hit || !hit.found) return "";
      return formatJsonRead(hit.value);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonSet",
    category: "JSON",
    description:
      "Return the JSON with a value written at a path, creating missing objects and arrays ([] appends). " +
      "A value that parses as JSON is stored as JSON, anything else as a string. On failure the JSON " +
      "comes back unchanged. Usage: {{jsonSet::{{getchatvar::state}}::party[0].hp::10}} or " +
      "{{jsonSet::json::path}}value{{/jsonSet}}",
    returnType: "string",
    args: [
      JSON_ARG,
      PATH_ARG,
      { name: "value", optional: true, description: "Value to write (or use the scoped body)" },
    ],
    delayArgResolution: true,
    aliases: ["json_set"],
    handler: async (ctx) => {
      const [source, pathArg = "", valueArg = ""] = await resolveJsonArgs(ctx);
      const valueText = ctx.isScoped ? await ctx.resolveNodes(ctx.bodyRaw) : valueArg;
      const doc = readDocument(ctx, source);
      const pathText = readJsonInput(pathArg, ctx.env).trim();
      const path = readPath(ctx, pathText, true);
      const typed = parseJsonWriteValue(readJsonInput(valueText, ctx.env));
      if (!typed.ok) warn(ctx, typed.error);
      else if (typed.value.malformedJson) warn(ctx, MALFORMED_JSON_VALUE_WARNING);
      if (!doc.ok || !path.ok || !typed.ok) return unchanged(ctx, source, doc);

      const updated = setJsonPath(doc.value, path.value, typed.value.value);
      if (!updated.ok) {
        warn(ctx, `cannot set "${pathText}": ${updated.error}`);
        return unchanged(ctx, source, doc);
      }
      const text = serializeJsonDocument(updated.value);
      if (!text.ok) {
        warn(ctx, text.error);
        return unchanged(ctx, source, doc);
      }
      return text.value;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonDelete",
    category: "JSON",
    description:
      "Return the JSON with the value at a path removed (array items are spliced out). " +
      "A missing path leaves it unchanged.",
    returnType: "string",
    args: [JSON_ARG, PATH_ARG],
    delayArgResolution: true,
    aliases: ["json_delete"],
    handler: async (ctx) => {
      const [source, pathArg = ""] = await resolveJsonArgs(ctx);
      const doc = readDocument(ctx, source);
      const path = readPath(ctx, readJsonInput(pathArg, ctx.env).trim());
      if (!doc.ok || !path.ok) return unchanged(ctx, source, doc);

      const removed = deleteJsonPath(doc.value, path.value);
      if (!removed.ok) {
        warn(ctx, removed.error);
        return unchanged(ctx, source, doc);
      }
      if (!removed.value || doc.value === undefined) return unchanged(ctx, source, doc);
      const text = serializeJsonDocument(doc.value);
      if (!text.ok) {
        warn(ctx, text.error);
        return unchanged(ctx, source, doc);
      }
      return text.value;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonHas",
    category: "JSON",
    description:
      "Check whether a path exists in JSON, even when it holds null, false, 0 or an empty string " +
      "(returns 'true' or 'false').",
    returnType: "boolean",
    args: [JSON_ARG, PATH_ARG],
    delayArgResolution: true,
    aliases: ["json_has"],
    handler: async (ctx) => {
      const [source, pathArg = ""] = await resolveJsonArgs(ctx);
      return lookUp(ctx, source, pathArg)?.found ? "true" : "false";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonKeys",
    category: "JSON",
    description:
      "Comma-separated keys of the object, or indexes of the array, at a path in JSON. " +
      `Empty for anything else; capped at ${MAX_LIST_ITEMS}.`,
    returnType: "string",
    args: [JSON_ARG, OPTIONAL_PATH_ARG],
    delayArgResolution: true,
    aliases: ["json_keys"],
    handler: async (ctx) => {
      const [source, pathArg = ""] = await resolveJsonArgs(ctx);
      const hit = lookUp(ctx, source, pathArg);
      if (!hit || !hit.found) return "";
      const value = hit.value;
      let keys: string[];
      let total: number;
      if (Array.isArray(value)) {
        total = value.length;
        keys = Array.from({ length: Math.min(total, MAX_LIST_ITEMS) }, (_, i) => String(i));
      } else if (isJsonObject(value)) {
        keys = Object.keys(value);
        total = keys.length;
      } else {
        return "";
      }
      if (total > MAX_LIST_ITEMS) {
        warn(ctx, `capped at ${MAX_LIST_ITEMS} keys (got ${total})`);
        keys = keys.slice(0, MAX_LIST_ITEMS);
      }
      return shieldDataBraces(formatList(keys));
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonLength",
    category: "JSON",
    description:
      "Number of items in the array, keys in the object, or characters in the string at a path in JSON; " +
      "0 for anything else or a missing path.",
    returnType: "integer",
    args: [JSON_ARG, OPTIONAL_PATH_ARG],
    delayArgResolution: true,
    aliases: ["json_length"],
    handler: async (ctx) => {
      const [source, pathArg = ""] = await resolveJsonArgs(ctx);
      const hit = lookUp(ctx, source, pathArg);
      if (!hit) return "";
      if (!hit.found) return "0";
      const value = hit.value;
      if (Array.isArray(value) || typeof value === "string") return String(value.length);
      return isJsonObject(value) ? String(Object.keys(value).length) : "0";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonEscape",
    category: "JSON",
    description:
      "Escape text for use inside a JSON string: quotes, backslashes, control characters, braces and <. " +
      'Scoped: {{jsonEscape}}text{{/jsonEscape}}. Usage: {"note":"{{jsonEscape::{{lastMessage}}}}"}',
    returnType: "string",
    args: [{ name: "text", description: "Text to escape (or use the scoped body)" }],
    delayArgResolution: true,
    aliases: ["json_escape"],
    handler: async (ctx) => {
      const [text] = await resolveJsonArgs(ctx);
      const input = ctx.isScoped ? await ctx.resolveNodes(ctx.bodyRaw) : text;
      return escapeJsonString(readJsonInput(input, ctx.env));
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonPretty",
    category: "JSON",
    description: "Format JSON with 2-space indentation. Invalid JSON comes back unchanged.",
    returnType: "string",
    args: [JSON_ARG],
    delayArgResolution: true,
    aliases: ["json_pretty"],
    handler: async (ctx) => {
      const [source] = await resolveJsonArgs(ctx);
      const doc = readDocument(ctx, source);
      if (!doc.ok || doc.value === undefined) return unchanged(ctx, source, doc);
      const text = trySerializeJson(doc.value, 2);
      if (!text.ok) {
        warn(ctx, text.error);
        return unchanged(ctx, source, doc);
      }
      return text.value;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "jsonBlock",
    category: "JSON",
    description:
      "The JSON inside a <json>…</json> block in the text, as compact JSON. Blocks that are not valid " +
      "JSON are skipped. Picks the first valid block, or the one at an index (negative counts from the " +
      "end); empty when there is none. Usage: {{jsonBlock::{{lastCharMessage}}::-1}}",
    returnType: "string",
    args: [
      { name: "text", description: "Text containing <json>…</json> blocks, e.g. {{lastCharMessage}}" },
      { name: "index", optional: true, description: "0-based index among valid blocks; negative counts from the end" },
    ],
    delayArgResolution: true,
    aliases: ["json_block"],
    handler: async (ctx) => {
      const [source, indexArg = ""] = await resolveJsonArgs(ctx);
      const indexText = indexArg.trim() || "0";
      if (!WHOLE_NUMBER_RE.test(indexText)) {
        warn(ctx, `index "${indexText}" is not a whole number`);
        return "";
      }
      const text = readJsonInput(source, ctx.env);
      if (text.length > MAX_JSON_TEXT_LENGTH) {
        warn(ctx, `the text exceeds ${MAX_JSON_TEXT_LENGTH.toLocaleString("en-US")} characters`);
        return "";
      }
      // findJsonBlocks keeps the blocks JSON.parse accepts. One holding a number
      // such as 1e999 (Infinity) is not valid here: serializing it would write null.
      const blocks = findJsonBlocks(text).filter((block) => !hasNonFiniteNumber(block.value as JsonValue));
      const index = resolveIndex(Number(indexText), blocks.length);
      if (index < 0 || index >= blocks.length) return "";
      const json = trySerializeJson(blocks[index].value as JsonValue);
      if (!json.ok) {
        warn(ctx, json.error);
        return "";
      }
      return json.value;
    },
  });
}
