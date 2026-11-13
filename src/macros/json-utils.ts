import { ESCAPED_CLOSE, ESCAPED_OPEN } from "./MacroParser";
import { LITERAL_BRACE_CLOSE, LITERAL_BRACE_OPEN, restoreLiteralBraces } from "./literal-braces";
import { resolveIndex } from "./list-utils";

/**
 * Pure helpers behind the JSON macros ({{jsonGet}}, {{setchatvarkey}}, …).
 *
 * Every value in the engine is a string, so these helpers parse JSON text,
 * read or edit it by path, and turn the result back into text. That text must
 * stay data: the evaluator re-parses macro output while it converges and
 * prompt assembly runs another macro pass after regex scripts, so nothing
 * produced here may contain a `{{` that a later pass could execute.
 */

/** Longest JSON text, write value, or write result the macros accept. */
export const MAX_JSON_TEXT_LENGTH = 1_000_000;
/** Most segments a path may have. */
export const MAX_JSON_PATH_SEGMENTS = 64;

const LIMIT_LABEL = MAX_JSON_TEXT_LENGTH.toLocaleString("en-US");

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * One parsed path segment. Index-like segments (`0`, `-1`, `[2]`) index arrays
 * and act as the string key `key` on objects; quoted bracket keys are always
 * `key` segments. `append` is `[]`.
 */
export type JsonPathSegment =
  | { kind: "key"; key: string }
  | { kind: "index"; key: string; index: number }
  | { kind: "append" };

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type JsonLookup = { found: true; value: JsonValue } | { found: false };

export interface JsonWriteValue {
  value: JsonValue;
  /** Kept as a string although the text starts like an object or array. */
  malformedJson: boolean;
}

export interface JsonPathOptions {
  /** Accept `[]` as the last segment. Only writes may append. */
  allowAppend?: boolean;
}

/** Warning for a write value that starts like JSON but was written as a string. */
export const MALFORMED_JSON_VALUE_WARNING =
  "the value starts like JSON but does not parse, so it was written as a string. " +
  "Inside an inline argument, }} closes the macro and :: starts the next argument; " +
  "pass JSON as the scoped body or through a variable instead";

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

// Both literal-brace sentinels start with \x00; ESCAPED_OPEN/CLOSE are \x01/\x02.
const BRACE_ENCODING_RE = /[\x00\x01\x02]/;
const DATA_BRACE_RE = /[{}\x01\x02]/g;
const STARTS_WITH_TAG_RE = /^\s*</;
const JSON_OPEN_TAG = "<json>";
const JSON_CLOSE_TAG = "</json>";

/**
 * Turn both brace encodings in macro input into real braces: `\{`/`\}` escapes
 * reach handlers as ESCAPED_OPEN/ESCAPED_CLOSE, and `{{#escape}}` bodies as the
 * literal-brace sentinels. Macros read input through `readJsonInput`
 * (json-blocks.ts), which also brings back the `<json>` blocks a chat message
 * pass held out; the parsers below take text read that way.
 */
export function normalizeJsonInput(text: string): string {
  if (!BRACE_ENCODING_RE.test(text)) return text;
  return restoreLiteralBraces(text.replaceAll(ESCAPED_OPEN, "{").replaceAll(ESCAPED_CLOSE, "}"));
}

/**
 * Strip one `<json>`/`</json>` pair from text that starts and ends with them
 * (tags in any case, surrounding whitespace allowed). Anything else comes back
 * unchanged. What lies between is left to the JSON parse: a string in it may
 * hold either tag, and two blocks in a row leave `…</json><json>…` between,
 * which no parse accepts.
 */
export function unwrapJsonBlock(text: string): string {
  if (!STARTS_WITH_TAG_RE.test(text)) return text;
  const trimmed = text.trim();
  if (
    trimmed.length < JSON_OPEN_TAG.length + JSON_CLOSE_TAG.length ||
    trimmed.slice(0, JSON_OPEN_TAG.length).toLowerCase() !== JSON_OPEN_TAG ||
    trimmed.slice(-JSON_CLOSE_TAG.length).toLowerCase() !== JSON_CLOSE_TAG
  ) {
    return text;
  }
  return trimmed.slice(JSON_OPEN_TAG.length, -JSON_CLOSE_TAG.length);
}

/**
 * Make text taken from a JSON value inert for later macro passes: raw braces
 * and escaped-brace sentinels become literal-brace sentinels, which turn back
 * into braces once no pass can run again. Unlike `shieldLiteralBraces`, a
 * backslash is never read as an escape, so data such as `a\{b` keeps it.
 */
export function shieldDataBraces(text: string): string {
  return text.replace(DATA_BRACE_RE, (brace) =>
    brace === "{" || brace === ESCAPED_OPEN ? LITERAL_BRACE_OPEN : LITERAL_BRACE_CLOSE,
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

// Each string literal in valid JSON text, escapes included.
const JSON_STRING_LITERAL_RE = /"[^"\\]*(?:\\.[^"\\]*)*"/g;
const MACRO_SYNTAX_RE = /[{}<]/g;
const UNICODE_ESCAPES: Record<string, string> = { "{": "\\u007b", "}": "\\u007d", "<": "\\u003c" };

/**
 * `JSON.stringify` whose output can never open a macro: `{`, `}` and `<` inside
 * string literals are written as `\u007b`, `\u007d` and `\u003c`, because a
 * later pass reads `{{` as a macro and rewrites legacy `<user>`/`<char>`/`<bot>`
 * tags. Structural braces never form `{{` (an object cannot directly contain
 * an object), so the text stays valid JSON for the same value, even after any
 * number of later macro passes.
 *
 * Throws a RangeError only for values nested too deeply for `JSON.stringify`.
 */
export function serializeJson(value: JsonValue, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(JSON_STRING_LITERAL_RE, (literal) =>
    literal.replace(MACRO_SYNTAX_RE, (char) => UNICODE_ESCAPES[char]),
  );
}

/**
 * Make valid JSON text inert for later macro passes without reformatting it:
 * each string literal is re-serialized by `serializeJson`, which escapes the
 * braces and `<` in it, and the rest keeps its exact text, so spacing and
 * numbers such as 1e999 or integers past 2^53 stay as written. Text around
 * the JSON may hold no `"`, so a `<json>…</json>` wrapper is fine.
 */
export function shieldJsonStrings(text: string): string {
  return text.replace(JSON_STRING_LITERAL_RE, (literal) => serializeJson(JSON.parse(literal)));
}

/** `serializeJson` that reports a too-deeply nested value instead of throwing. */
export function trySerializeJson(value: JsonValue, indent?: number): JsonResult<string> {
  try {
    return ok(serializeJson(value, indent));
  } catch {
    return fail("the value is nested too deeply to serialize");
  }
}

/**
 * Serialize a write result as compact inert JSON. The result faces the input
 * size limit so a stored document never outgrows what the next read accepts.
 */
export function serializeJsonDocument(value: JsonValue): JsonResult<string> {
  const text = trySerializeJson(value);
  if (text.ok && text.value.length > MAX_JSON_TEXT_LENGTH) {
    return fail(`the result would exceed ${LIMIT_LABEL} characters`);
  }
  return text;
}

/**
 * Escape text for use inside a JSON string literal (without the quotes), with
 * `{`, `}` and `<` written as unicode escapes as in `serializeJson`.
 */
export function escapeJsonString(text: string): string {
  return serializeJson(text).slice(1, -1);
}

/**
 * Render a read result as macro output: a string as its shielded text, a
 * number or boolean via `String()`, null or missing as "", and an object or
 * array as compact inert JSON (see `serializeJson` for the one throw).
 */
export function formatJsonRead(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return shieldDataBraces(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return serializeJson(value);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const BLANK_RE = /^\s*$/;
const INDEX_LIKE_RE = /^-?\d+$/;
const STARTS_LIKE_JSON_RE = /^[[{]/;

/**
 * Whether a parsed tree holds a number JSON cannot carry: `1e999` parses as
 * Infinity, which `JSON.stringify` would silently write as null. Iterative, so
 * deep nesting cannot overflow the stack.
 */
export function hasNonFiniteNumber(root: JsonValue): boolean {
  const pending: JsonValue[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) return true;
    } else if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
    } else if (isJsonObject(node)) {
      for (const child of Object.values(node)) pending.push(child);
    }
  }
  return false;
}

/**
 * Parse JSON text from an argument or variable. Blank text is "no document"
 * (`undefined`): readers treat it as missing and writers create it. JSON with
 * a number too large to store is invalid.
 */
export function parseJsonDocument(text: string): JsonResult<JsonValue | undefined> {
  const json = unwrapJsonBlock(text);
  if (BLANK_RE.test(json)) return ok(undefined);
  if (json.length > MAX_JSON_TEXT_LENGTH) {
    return fail(`the JSON text exceeds ${LIMIT_LABEL} characters`);
  }
  let value: JsonValue;
  try {
    value = JSON.parse(json) as JsonValue;
  } catch (err) {
    return fail(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return hasNonFiniteNumber(value) ? fail("not valid JSON (a number is out of range)") : ok(value);
}

/**
 * Type a value to write: blank → "", valid JSON → the parsed value, anything
 * else → the text itself. JSON with a number too large to store, such as
 * `[1e999]`, counts as anything else.
 */
export function parseJsonWriteValue(text: string): JsonResult<JsonWriteValue> {
  if (text.length > MAX_JSON_TEXT_LENGTH) return fail(`the value exceeds ${LIMIT_LABEL} characters`);
  const candidate = unwrapJsonBlock(text).trim();
  if (candidate === "") return ok({ value: "", malformedJson: false });
  try {
    const parsed = JSON.parse(candidate) as JsonValue;
    if (!hasNonFiniteNumber(parsed)) return ok({ value: parsed, malformedJson: false });
  } catch {
    // Not JSON: written as text below.
  }
  return ok({ value: text, malformedJson: STARTS_LIKE_JSON_RE.test(candidate) });
}

/**
 * Parse a path such as `party[0].name`, `items[-1]`, `["key.with.dots"]` or
 * `['k']`. A blank path is the root. A bare segment is any run of characters
 * other than `.`, `[` and `]`; quoted keys accept `\\`, `\"` and `\'`.
 * Invalid grammar is reported, never thrown.
 */
export function parseJsonPath(path: string, options: JsonPathOptions = {}): JsonResult<JsonPathSegment[]> {
  const text = path.trim();
  const segments: JsonPathSegment[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (segments.length === MAX_JSON_PATH_SEGMENTS) {
      return fail(`a path may have at most ${MAX_JSON_PATH_SEGMENTS} segments`);
    }
    if (text[pos] === "[") {
      const next = readBracketSegment(text, pos, segments);
      if (!next.ok) return next;
      pos = next.value;
      continue;
    }
    if (pos > 0) {
      if (text[pos] !== ".") return fail(`unexpected "${text[pos]}" after a segment`);
      pos++;
    }
    let end = pos;
    while (end < text.length && text[end] !== "." && text[end] !== "[" && text[end] !== "]") end++;
    if (end === pos) return fail("empty segment");
    const key = text.slice(pos, end);
    segments.push(INDEX_LIKE_RE.test(key) ? { kind: "index", key, index: Number(key) } : { kind: "key", key });
    pos = end;
  }

  const appendAt = segments.findIndex((segment) => segment.kind === "append");
  if (appendAt >= 0) {
    if (!options.allowAppend) return fail("[] (append) is only valid when writing");
    if (appendAt !== segments.length - 1) return fail("[] (append) must be the last segment");
  }
  return ok(segments);
}

/** Read the bracket segment opening at `start` into `segments`; returns the position after it. */
function readBracketSegment(text: string, start: number, segments: JsonPathSegment[]): JsonResult<number> {
  let pos = start + 1;
  const first = text.charAt(pos);
  if (first === "]") {
    segments.push({ kind: "append" });
    return ok(pos + 1);
  }

  if (first === '"' || first === "'") {
    let key = "";
    pos++;
    while (pos < text.length && text[pos] !== first) {
      if (text[pos] === "\\") {
        const escaped = text.charAt(pos + 1);
        if (escaped !== "\\" && escaped !== '"' && escaped !== "'") {
          return fail(`unsupported escape "\\${escaped}" in a quoted key`);
        }
        key += escaped;
        pos += 2;
      } else {
        key += text[pos];
        pos++;
      }
    }
    if (pos >= text.length) return fail("unterminated quoted key");
    if (text.charAt(pos + 1) !== "]") return fail('expected "]" after a quoted key');
    segments.push({ kind: "key", key });
    return ok(pos + 2);
  }

  const close = text.indexOf("]", pos);
  if (close < 0) return fail('unterminated "["');
  const inner = text.slice(pos, close);
  if (!INDEX_LIKE_RE.test(inner)) {
    return fail(`"[${inner}]" is not an index such as [0] or [-1], [] or a quoted key such as ["name"]`);
  }
  segments.push({ kind: "index", key: inner, index: Number(inner) });
  return ok(close + 1);
}

// ---------------------------------------------------------------------------
// Reading and editing by path
// ---------------------------------------------------------------------------

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "a string", "an array", … for messages. */
export function jsonTypeName(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/** The existing child a segment names: own properties only, and arrays answer only to indexes. */
function childOf(node: JsonValue, segment: JsonPathSegment): JsonValue | undefined {
  if (Array.isArray(node)) {
    if (segment.kind !== "index") return undefined;
    const index = resolveIndex(segment.index, node.length);
    return index >= 0 && index < node.length ? node[index] : undefined;
  }
  if (isJsonObject(node) && segment.kind !== "append" && Object.hasOwn(node, segment.key)) {
    return node[segment.key];
  }
  return undefined;
}

/** Read the value at `path`; `undefined` (no document) has nothing in it. */
export function getJsonPath(root: JsonValue | undefined, path: readonly JsonPathSegment[]): JsonLookup {
  if (root === undefined) return { found: false };
  let node: JsonValue = root;
  for (const segment of path) {
    const child = childOf(node, segment);
    if (child === undefined) return { found: false };
    node = child;
  }
  return { found: true, value: node };
}

/** Where a segment lands in an existing container; an array index equal to its length appends. */
type Slot = { kind: "object"; target: JsonObject; key: string } | { kind: "array"; target: JsonValue[]; index: number };

function slotFor(node: JsonValue, segment: JsonPathSegment): JsonResult<Slot> {
  if (Array.isArray(node)) {
    if (segment.kind === "append") return ok<Slot>({ kind: "array", target: node, index: node.length });
    if (segment.kind === "key") return fail(`arrays take numeric indexes, not "${segment.key}"`);
    const index = resolveIndex(segment.index, node.length);
    if (index < 0) return fail(`index ${segment.key} is out of range for an array of length ${node.length}`);
    if (index > node.length) {
      return fail(`index ${segment.key} would leave a gap in an array of length ${node.length}`);
    }
    return ok<Slot>({ kind: "array", target: node, index });
  }
  if (isJsonObject(node)) {
    if (segment.kind === "append") return fail("[] can only append to an array");
    return ok<Slot>({ kind: "object", target: node, key: segment.key });
  }
  return fail(`cannot write inside ${jsonTypeName(node)}`);
}

/**
 * Put a value in a slot. Object keys are defined rather than assigned, so
 * "__proto__" stays an ordinary own key instead of reaching the prototype setter.
 */
function fillSlot(slot: Slot, value: JsonValue): void {
  if (slot.kind === "array") slot.target[slot.index] = value;
  else Object.defineProperty(slot.target, slot.key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Build the new containers below a missing node, innermost first: an array for
 * an index or `[]` segment, an object for a key. A new array is empty, so only
 * index 0 (or `[]`) can land in it.
 */
function buildContainers(path: readonly JsonPathSegment[], start: number, value: JsonValue): JsonResult<JsonValue> {
  let node = value;
  for (let i = path.length - 1; i >= start; i--) {
    const segment = path[i];
    if (segment.kind === "key") {
      const object: JsonObject = {};
      fillSlot({ kind: "object", target: object, key: segment.key }, node);
      node = object;
    } else if (segment.kind === "append" || segment.index === 0) {
      node = [node];
    } else {
      return fail(`index ${segment.key} is out of range for a new, empty array`);
    }
  }
  return ok(node);
}

/**
 * Write `value` at `path` and return the resulting root. Containers are edited
 * in place, but only once the whole write is known to succeed: on failure
 * nothing changes. A missing or null root ("no document") or container along
 * the path is created; any other scalar on the path is an error.
 */
export function setJsonPath(
  root: JsonValue | undefined,
  path: readonly JsonPathSegment[],
  value: JsonValue,
): JsonResult<JsonValue> {
  if (path.length === 0) return ok(value);
  if (root === undefined || root === null) return buildContainers(path, 0, value);

  let node: JsonValue = root;
  const last = path.length - 1;
  for (let i = 0; i < last; i++) {
    const slot = slotFor(node, path[i]);
    if (!slot.ok) return slot;
    const child = childOf(node, path[i]);
    if (child === undefined || child === null) {
      const branch = buildContainers(path, i + 1, value);
      if (!branch.ok) return branch;
      fillSlot(slot.value, branch.value);
      return ok(root);
    }
    node = child;
  }
  const slot = slotFor(node, path[last]);
  if (!slot.ok) return slot;
  fillSlot(slot.value, value);
  return ok(root);
}

/**
 * Delete the value at `path` in place, splicing array elements out. Returns
 * whether anything changed; a missing path is a no-op. The root itself cannot
 * be deleted.
 */
export function deleteJsonPath(root: JsonValue | undefined, path: readonly JsonPathSegment[]): JsonResult<boolean> {
  if (path.length === 0) return fail("a path is required; the whole value cannot be deleted");
  const parent = getJsonPath(root, path.slice(0, -1));
  if (!parent.found) return ok(false);
  const container = parent.value;
  const segment = path[path.length - 1];
  if (Array.isArray(container)) {
    if (segment.kind !== "index") return ok(false);
    const index = resolveIndex(segment.index, container.length);
    if (index < 0 || index >= container.length) return ok(false);
    container.splice(index, 1);
    return ok(true);
  }
  if (isJsonObject(container) && segment.kind !== "append" && Object.hasOwn(container, segment.key)) {
    delete container[segment.key];
    return ok(true);
  }
  return ok(false);
}
