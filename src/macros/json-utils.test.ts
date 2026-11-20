import { describe, expect, test } from "bun:test";
import { ESCAPED_CLOSE, ESCAPED_OPEN } from "./MacroParser";
import { LITERAL_BRACE_CLOSE, LITERAL_BRACE_OPEN, restoreLiteralBraces } from "./literal-braces";
import {
  MAX_JSON_PATH_SEGMENTS,
  MAX_JSON_TEXT_LENGTH,
  deleteJsonPath,
  escapeJsonString,
  formatJsonRead,
  getJsonPath,
  normalizeJsonInput,
  parseJsonDocument,
  parseJsonPath,
  parseJsonWriteValue,
  serializeJson,
  serializeJsonDocument,
  setJsonPath,
  shieldDataBraces,
  shieldJsonStrings,
  trySerializeJson,
  unwrapJsonBlock,
  type JsonLookup,
  type JsonPathSegment,
  type JsonResult,
  type JsonValue,
} from "./json-utils";

const key = (name: string): JsonPathSegment => ({ kind: "key", key: name });
const at = (index: string): JsonPathSegment => ({ kind: "index", key: index, index: Number(index) });
const append: JsonPathSegment = { kind: "append" };

/** Unwrap a result the test expects to succeed. */
function expectOk<T>(result: JsonResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  return result.value;
}

/** A path the test expects to be valid (appends allowed). */
function path(text: string): JsonPathSegment[] {
  return expectOk(parseJsonPath(text, { allowAppend: true }));
}

describe("parseJsonPath", () => {
  test.each<[string, JsonPathSegment[]]>([
    ["", []],
    ["   ", []],
    ["name", [key("name")]],
    ["  a.b  ", [key("a"), key("b")]],
    ["party[0].name", [key("party"), at("0"), key("name")]],
    ["items[-1]", [key("items"), at("-1")]],
    ["items.-1", [key("items"), at("-1")]],
    ["0.name", [at("0"), key("name")]],
    ["grid[1][2]", [key("grid"), at("1"), at("2")]],
    ['["key.with.dots"]', [key("key.with.dots")]],
    ["['k']", [key("k")]],
    [`a["b c"]['d']`, [key("a"), key("b c"), key("d")]],
    ['["0"]', [key("0")]],
    ['[""]', [key("")]],
    [String.raw`["say \"hi\""]`, [key('say "hi"')]],
    [String.raw`['it\'s']`, [key("it's")]],
    [String.raw`["back\\slash"]`, [key("back\\slash")]],
    ["first name.last-name", [key("first name"), key("last-name")]],
    ["__proto__.constructor", [key("__proto__"), key("constructor")]],
    ["items[]", [key("items"), append]],
    ["[]", [append]],
  ])("%p parses", (text, expected) => {
    expect(parseJsonPath(text, { allowAppend: true })).toEqual({ ok: true, value: expected });
  });

  test.each<[string, boolean]>([
    [".a", true],
    ["a.", true],
    ["a..b", true],
    ["a.[0]", true],
    ["a[", true],
    ["a[0", true],
    ["a]", true],
    ["a[b]", true],
    ["a[ 0 ]", true],
    ["a[0]b", true],
    ['a["b"', true],
    ['a["b"x]', true],
    [String.raw`["a\nb"]`, true],
    ["a[].b", true],
    ["a[]", false],
  ])("%p is rejected (appends allowed: %p)", (text, allowAppend) => {
    expect(parseJsonPath(text, { allowAppend }).ok).toBe(false);
  });

  test(`accepts ${MAX_JSON_PATH_SEGMENTS} segments and rejects more`, () => {
    const keys = Array.from({ length: MAX_JSON_PATH_SEGMENTS }, (_, i) => `k${i}`);
    expect(expectOk(parseJsonPath(keys.join(".")))).toHaveLength(MAX_JSON_PATH_SEGMENTS);
    expect(parseJsonPath([...keys, "extra"].join(".")).ok).toBe(false);
    expect(parseJsonPath("[0]".repeat(MAX_JSON_PATH_SEGMENTS + 1)).ok).toBe(false);
  });
});

describe("parseJsonWriteValue", () => {
  test.each<[string, JsonValue, boolean]>([
    ["", "", false],
    ["   ", "", false],
    ["42", 42, false],
    [" 42 ", 42, false],
    ["-1.5", -1.5, false],
    ["true", true, false],
    ["null", null, false],
    ['"quoted"', "quoted", false],
    ['{"a":1}', { a: 1 }, false],
    ["[1,2]", [1, 2], false],
    ["hello", "hello", false],
    ["  padded text  ", "  padded text  ", false],
    ["007", "007", false],
    ["1e999", "1e999", false],
    ["[1e999]", "[1e999]", true],
    ['{"a":{"b":[1,-1e999]}}', '{"a":{"b":[1,-1e999]}}', true],
    ['{"a":', '{"a":', true],
    ["[1,", "[1,", true],
    [' <JSON> {"a":[1]} </json> ', { a: [1] }, false],
    ['<json>{"tag":"</json>"}</json>', { tag: "</json>" }, false],
    ['<json>{"a":1}</json><json>{"b":2}</json>', '<json>{"a":1}</json><json>{"b":2}</json>', true],
  ])("%p is written as %p", (text, value, malformedJson) => {
    expect(parseJsonWriteValue(text)).toEqual({ ok: true, value: { value, malformedJson } });
  });

  test("rejects a value over the size limit", () => {
    expect(parseJsonWriteValue("x".repeat(MAX_JSON_TEXT_LENGTH)).ok).toBe(true);
    expect(parseJsonWriteValue("x".repeat(MAX_JSON_TEXT_LENGTH + 1)).ok).toBe(false);
  });
});

describe("JSON text normalization", () => {
  test("decodes both brace encodings", () => {
    expect(normalizeJsonInput(`${ESCAPED_OPEN}"a":1${ESCAPED_CLOSE}`)).toBe('{"a":1}');
    expect(normalizeJsonInput(`${LITERAL_BRACE_OPEN}"a":1${LITERAL_BRACE_CLOSE}`)).toBe('{"a":1}');
    expect(normalizeJsonInput("plain")).toBe("plain");
  });

  test("unwraps one outer <json> pair and leaves the rest to the JSON parse", () => {
    expect(unwrapJsonBlock('  <JSON>{"a":1}</Json>\n')).toBe('{"a":1}');
    // A JSON string may hold either tag.
    expect(unwrapJsonBlock('<json>{"tag":"</json>","hp":3}</json>')).toBe('{"tag":"</json>","hp":3}');
    // Two blocks in a row unwrap to text no JSON parse accepts.
    expect(unwrapJsonBlock('<json>{"a":1}</json><json>{"b":2}</json>')).toBe('{"a":1}</json><json>{"b":2}');
    expect(unwrapJsonBlock('x <json>{"a":1}</json>')).toBe('x <json>{"a":1}</json>');
    expect(unwrapJsonBlock('{"a":1}')).toBe('{"a":1}');
  });

  test("parseJsonDocument unwraps a block and treats blank text as no document", () => {
    expect(parseJsonDocument("<json>[1,2]</json>")).toEqual({ ok: true, value: [1, 2] });
    expect(parseJsonDocument('<json>{"tag":"</json>","hp":3}</json>')).toEqual({
      ok: true,
      value: { tag: "</json>", hp: 3 },
    });
    expect(parseJsonDocument('<json>{"a":1}</json><json>{"b":2}</json>').ok).toBe(false);
    expect(parseJsonDocument("  ")).toEqual({ ok: true, value: undefined });
    expect(parseJsonDocument("null")).toEqual({ ok: true, value: null });
    expect(parseJsonDocument("not json").ok).toBe(false);
  });

  test.each(["1e999", "[1e999]", '{"a":{"b":[1,-1e999]}}', '{"n":1e999,"hp":1}'])(
    "parseJsonDocument rejects %p, whose number is too large to store",
    (text) => {
      expect(parseJsonDocument(text)).toEqual({ ok: false, error: "not valid JSON (a number is out of range)" });
    },
  );

  test("parseJsonDocument rejects text over the size limit", () => {
    const fits = `"${"a".repeat(MAX_JSON_TEXT_LENGTH - 2)}"`;
    expect(parseJsonDocument(fits).ok).toBe(true);
    // Trailing whitespace is valid JSON, so only the limit rejects this.
    expect(parseJsonDocument(`${fits} `).ok).toBe(false);
  });
});

describe("serialization and read formatting", () => {
  test("serializeJson escapes braces and < in strings, so output never opens a macro", () => {
    const value: JsonValue = {
      text: "{{setvar::x::pwned}}",
      "k{": ["}}", "a\\{b", 'quote " and {brace}'],
      "<user>": "<char> and <BOT>",
      nested: { deeper: { list: [{ n: 1 }] } },
    };
    const compact = serializeJson(value);
    expect(compact).not.toContain("{{");
    expect(compact).not.toContain("<");
    expect(compact).toContain(String.raw`"text":"\u007b\u007bsetvar::x::pwned\u007d\u007d"`);
    expect(compact).toContain(String.raw`"\u003cuser>":"\u003cchar> and \u003cBOT>"`);
    expect(JSON.parse(compact)).toEqual(value);

    const pretty = serializeJson(value, 2);
    expect(pretty).not.toContain("{{");
    expect(pretty).not.toContain("<");
    expect(pretty).toContain('\n  "text": ');
    expect(JSON.parse(pretty)).toEqual(value);
  });

  test("write results face the size limit", () => {
    expect(serializeJsonDocument("a".repeat(MAX_JSON_TEXT_LENGTH - 2)).ok).toBe(true);
    expect(serializeJsonDocument("a".repeat(MAX_JSON_TEXT_LENGTH - 1)).ok).toBe(false);
  });

  test("trySerializeJson reports values too deep for JSON.stringify instead of throwing", () => {
    let deep: JsonValue = [];
    for (let i = 0; i < 500_000; i++) deep = [deep];
    expect(trySerializeJson(deep).ok).toBe(false);
  });

  test("formatJsonRead renders values as inert text", () => {
    expect(formatJsonRead(undefined)).toBe("");
    expect(formatJsonRead(null)).toBe("");
    expect(formatJsonRead(1.5)).toBe("1.5");
    expect(formatJsonRead(false)).toBe("false");
    expect(formatJsonRead({ a: "{x}" })).toBe(String.raw`{"a":"\u007bx\u007d"}`);

    const text = formatJsonRead("{{user}} a\\{b");
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
    expect(restoreLiteralBraces(text)).toBe("{{user}} a\\{b");
  });

  test("shieldDataBraces maps both sentinel families and keeps backslashes", () => {
    expect(shieldDataBraces(`a\\{${ESCAPED_OPEN}${ESCAPED_CLOSE}}`)).toBe(
      `a\\${LITERAL_BRACE_OPEN}${LITERAL_BRACE_OPEN}${LITERAL_BRACE_CLOSE}${LITERAL_BRACE_CLOSE}`,
    );
    expect(shieldDataBraces(`${LITERAL_BRACE_OPEN}x`)).toBe(`${LITERAL_BRACE_OPEN}x`);
  });

  test("shieldJsonStrings escapes inside strings only and keeps the rest as written", () => {
    const text = String.raw` <json>{ "k\"{": "{{user}} <char>", "n": 1.50, "big": 12345678901234567891, "inf": 1e999 }</json>`;
    expect(shieldJsonStrings(text)).toBe(
      String.raw` <json>{ "k\"\u007b": "\u007b\u007buser\u007d\u007d \u003cchar>", "n": 1.50, "big": 12345678901234567891, "inf": 1e999 }</json>`,
    );
  });

  test("escapeJsonString produces the inside of a JSON string literal", () => {
    expect(escapeJsonString('He said "hi"\n{{user}} <char>')).toBe(
      String.raw`He said \"hi\"\n\u007b\u007buser\u007d\u007d \u003cchar>`,
    );
    const text = 'tab\t"q" \\ {} <bot>';
    expect(JSON.parse(`"${escapeJsonString(text)}"`)).toBe(text);
  });
});

describe("getJsonPath", () => {
  const root: JsonValue = { party: [{ name: "Ann" }, { name: "Bo" }], "a.b": 1, "0": "zero", nothing: null };

  test.each<[string, JsonLookup]>([
    ["party[1].name", { found: true, value: "Bo" }],
    ["party[-1].name", { found: true, value: "Bo" }],
    ["party.0.name", { found: true, value: "Ann" }],
    ['["a.b"]', { found: true, value: 1 }],
    ["0", { found: true, value: "zero" }],
    ["nothing", { found: true, value: null }],
    ["", { found: true, value: root }],
    ["party[2]", { found: false }],
    ["party[-3]", { found: false }],
    ["party.name", { found: false }],
    ["nothing.deeper", { found: false }],
    ["party[0].name.first", { found: false }],
  ])("%p", (text, expected) => {
    expect(getJsonPath(root, path(text))).toEqual(expected);
  });

  test("no document has nothing in it", () => {
    expect(getJsonPath(undefined, [])).toEqual({ found: false });
  });
});

describe("setJsonPath", () => {
  test.each<[string, JsonValue | undefined, string, JsonValue, JsonValue]>([
    ["an index equal to the length appends", [1, 2], "[2]", 3, [1, 2, 3]],
    ["[] appends", [1, 2], "[]", 3, [1, 2, 3]],
    ["a negative index replaces from the end", [1, 2], "[-1]", 9, [1, 9]],
    ["a missing document becomes containers", undefined, "party[0].name", "Ann", { party: [{ name: "Ann" }] }],
    ["a null document becomes an array", null, "[0]", "x", ["x"]],
    ["a null container is replaced", { a: null }, "a.b", 1, { a: { b: 1 } }],
    ["a missing container for [] is an array", {}, "list[]", "x", { list: ["x"] }],
    ["an index-like segment is a key on objects", { "0": "x" }, "0", "y", { "0": "y" }],
    ["a quoted key never indexes", {}, '["0"]', true, { "0": true }],
    ["an empty path replaces the root", { a: 1 }, "", [1], [1]],
    ["an existing value is overwritten", { a: { b: 1 } }, "a.b", { c: [] }, { a: { b: { c: [] } } }],
  ])("%s", (_name, root, pathText, value, expected) => {
    expect(setJsonPath(root, path(pathText), value)).toEqual({ ok: true, value: expected });
  });

  test.each<[string, JsonValue, string]>([
    ["a gap past the end", [1, 2], "[3]"],
    ["a negative index before the start", [1, 2], "[-3]"],
    ["a gap in a new array", {}, "list[1]"],
    ["a negative index in a new array", {}, "list[-1]"],
    ["a gap below a new container", { a: {} }, "a.b[1].c"],
    ["a key on an array", { list: [] }, "list.name"],
    ["[] on an object", { obj: {} }, "obj[]"],
    ["traversing into a number", { hp: 5 }, "hp.max"],
    ["traversing into a string", { name: "Ann" }, "name[0]"],
    ["traversing into a scalar root", true, "a"],
  ])("fails without changing anything: %s", (_name, root, pathText) => {
    const before = JSON.stringify(root);
    expect(setJsonPath(root, path(pathText), "new").ok).toBe(false);
    expect(JSON.stringify(root)).toBe(before);
  });
});

describe("deleteJsonPath", () => {
  test.each<[string, JsonValue | undefined, string, boolean, JsonValue | undefined]>([
    ["splices an array element", [1, 2, 3], "[1]", true, [1, 3]],
    ["splices from the end", [1, 2, 3], "[-1]", true, [1, 2]],
    ["deletes an object key", { a: 1, b: 2 }, "a", true, { b: 2 }],
    ["deletes inside nested containers", { a: [{ b: 1, c: 2 }] }, "a[0].b", true, { a: [{ c: 2 }] }],
    ["ignores an index past the end", [1], "[5]", false, [1]],
    ["ignores a missing key", { a: 1 }, "x.y", false, { a: 1 }],
    ["ignores a key on an array", [1], "length", false, [1]],
    ["ignores a missing document", undefined, "a", false, undefined],
  ])("%s", (_name, root, pathText, changed, after) => {
    expect(deleteJsonPath(root, path(pathText))).toEqual({ ok: true, value: changed });
    expect(root).toEqual(after);
  });

  test("refuses to delete the root", () => {
    expect(deleteJsonPath({ a: 1 }, []).ok).toBe(false);
  });
});

describe("prototype safety", () => {
  test("__proto__ is an ordinary key that round-trips", () => {
    const written = expectOk(setJsonPath(expectOk(parseJsonDocument("{}")), path("__proto__.polluted"), true));
    const json = serializeJson(written);
    expect(json).toBe('{"__proto__":{"polluted":true}}');
    expect(Object.getPrototypeOf(written)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const reparsed = expectOk(parseJsonDocument(json));
    expect(getJsonPath(reparsed, path("__proto__.polluted"))).toEqual({ found: true, value: true });
    expect(deleteJsonPath(reparsed, path("__proto__"))).toEqual({ ok: true, value: true });
    expect(JSON.stringify(reparsed)).toBe("{}");

    // Containers created by a write treat it the same way.
    expect(serializeJson(expectOk(setJsonPath(undefined, path("a.__proto__.x"), 1)))).toBe(
      '{"a":{"__proto__":{"x":1}}}',
    );
  });

  test("inherited properties are invisible", () => {
    const root: JsonValue = { a: 1 };
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(getJsonPath(root, path(name))).toEqual({ found: false });
    }
    expect(getJsonPath([1, 2], path("length"))).toEqual({ found: false });
    expect(getJsonPath("text", path("length"))).toEqual({ found: false });
    expect(expectOk(setJsonPath({}, path("toString"), 1))).toEqual({ toString: 1 });
  });
});
