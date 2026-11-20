import { describe, expect, test } from "bun:test";
import {
  findJsonBlocks,
  findTopLevelJsonBlocks,
  protectJsonBlocks,
  readJsonInput,
  resolveJsonBlockPlaceholders,
  withJsonBlocksProtected,
} from "./json-blocks";
import { LITERAL_BRACE_CLOSE, LITERAL_BRACE_OPEN } from "./literal-braces";
import type { MacroEnv } from "./types";

type ProtectedEnv = Pick<MacroEnv, "variables" | "_chatVarsDirty" | "extra">;

function makeEnv(): ProtectedEnv {
  return { variables: { local: new Map(), chat: new Map(), global: new Map() }, extra: {} };
}

describe("findJsonBlocks", () => {
  test("returns only blocks whose inner text parses as JSON", () => {
    const source = '<json>{"hp": 3}</json>';
    const text = `a ${source} <json>{{getchatvar::state}}</json> <json></json> <json id="x">1</json>`;

    expect(findJsonBlocks(text)).toEqual([
      { start: 2, end: 2 + source.length, source, inner: '{"hp": 3}', value: { hp: 3 } },
    ]);
  });

  test("matches tags in any case", () => {
    expect(findJsonBlocks("<JSON>[1]</Json>").map((block) => block.value)).toEqual([[1]]);
  });

  test("ends a block at the first closing tag outside a JSON string", () => {
    // Inside a string, `</json>` is text.
    expect(findJsonBlocks('<json>"a</json>b"</json>').map((block) => block.value)).toEqual(["a</json>b"]);
    // Outside one, it ends the block, and the rest is text.
    expect(findJsonBlocks("<json>1</json>2</json>").map((block) => block.source)).toEqual(["<json>1</json>"]);
    // An opener without valid JSON is text and does not hide a later block.
    expect(findJsonBlocks('<json> draft <json>{"a":1}</json>').map((block) => block.source)).toEqual([
      '<json>{"a":1}</json>',
    ]);
  });

  test("never lets stray openers hide a later valid block", () => {
    const block = '<json>{"x":"{{setchatvar::owned::yes}}"}</json>';

    // Each stray opener starts like JSON and shares the block's closer.
    expect(findJsonBlocks(`${"<json>0 ".repeat(16)}${block}`).map((found) => [found.start, found.source])).toEqual([
      [8 * 16, block],
    ]);
  });

  test("JSON strings may hold either tag", () => {
    const block = '<json>{"tag":"<json>","x":"{{setchatvar::owned::yes}}"}</json>';

    expect(findJsonBlocks(`a ${block} b`).map((found) => [found.start, found.source])).toEqual([[2, block]]);
    expect(findJsonBlocks(String.raw`<json>{"a":"\u003cjson>"}</json>`).map((found) => found.value)).toEqual([
      { a: "<json>" },
    ]);
  });

  test("a stray opener in prose, even one before a quote, does not hide a later block", () => {
    const text = 'I said "<json>" is a tag. <json>{"a":1}</json>';

    expect(findJsonBlocks(text).map((block) => [block.start, block.source])).toEqual([
      [text.lastIndexOf("<json>"), '<json>{"a":1}</json>'],
    ]);
  });

  test("scans adversarial runs of openers in linear time", () => {
    const n = 20_000;
    const started = performance.now();

    // Openers that share one closer: each one sits outside the strings of the
    // one before, so the scan moves on to it without parsing.
    expect(findJsonBlocks(`${"<json>".repeat(n)}0</json>`).map((block) => [block.start, block.source])).toEqual([
      [6 * (n - 1), "<json>0</json>"],
    ]);
    expect(findJsonBlocks(`${"<json>0".repeat(n)}</json>`).map((block) => [block.start, block.source])).toEqual([
      [7 * (n - 1), "<json>0</json>"],
    ]);
    // Each opener's quote holds the next opener in a string.
    expect(findJsonBlocks('<json>"'.repeat(n))).toEqual([]);
    expect(findJsonBlocks(`${'<json>"'.repeat(n)}</json>`).map((block) => [block.start, block.value])).toEqual([
      [7 * (n - 2), "<json>"],
    ]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("ignores the text after too many rejected candidates, in linear time", () => {
    const block = '<json>{"a":1}</json>';
    // Escaped quotes keep every opener's string open to the end of the text,
    // so each opener is rejected only after a scan to the end.
    const opener = '\\"<json>';

    expect(findJsonBlocks(`<json>"${opener.repeat(100)}${block}`).map((found) => found.source)).toEqual([block]);
    const started = performance.now();
    expect(findJsonBlocks(`<json>"${opener.repeat(20_000)}${block}`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("findTopLevelJsonBlocks", () => {
  test("keeps only blocks outside every macro tag", () => {
    const block = '<json>{"a":{"b":1}}</json>';
    // The block's own `}}` closes the setter, as the lexer reads it, and the `}}` after it is plain text.
    const text = `{{setvar::x::${block}}} {{setchatvar::state}}${block}{{/setchatvar}}`;

    expect(findTopLevelJsonBlocks(text).blocks.map((found) => found.start)).toEqual([text.lastIndexOf(block)]);
  });

  test("counts tags as the macro lexer reads them", () => {
    const block = "<json>1</json>";

    // `\{` and `\}` are literal braces.
    expect(findTopLevelJsonBlocks(String.raw`\{\{ ${block} \}\}`).blocks).toHaveLength(1);
    expect(findTopLevelJsonBlocks(String.raw`{{x::\}} ${block}`).blocks).toEqual([]);
    // A `}}` outside every tag is plain text, so it cancels no later `{{`.
    expect(findTopLevelJsonBlocks(`}} ${block} }}{{x::${block}}}`).blocks.map((found) => found.start)).toEqual([3]);
    // A tag left open holds every block after it.
    expect(findTopLevelJsonBlocks(`{{x::${block}`).blocks).toEqual([]);
  });

  test("reads a block inside a tag as the tag's text, as the lexer does", () => {
    const block = '<json>{"x":"{{setchatvar::owned::yes}}"}</json>';
    // The lexer closes {{setvar}} at the first block's `}}`, so the second block is outside every tag.
    const closed = `{{setvar::v::<json>{"a":{}}</json>${block}`;
    // The tag closes inside a block's string, so an opener later in that string is outside every tag.
    const reopened = '{{setvar::v::<json>["}}<json>["]</json>{{setchatvar::owned::yes}}"]</json>';

    expect(findTopLevelJsonBlocks(closed).blocks.map((found) => [found.start, found.source])).toEqual([
      [closed.length - block.length, block],
    ]);
    expect(findTopLevelJsonBlocks(reopened).blocks.map((found) => found.source)).toEqual([
      '<json>["]</json>{{setchatvar::owned::yes}}"]</json>',
    ]);
  });

  test("stops at the rejected-candidate cap and reports where", () => {
    const block = "<json>[1]</json>";
    const stray = "<json>bad</json>";
    // The 256th rejected candidate stops the scan, so the block after it is never classified.
    const text = `${block}${stray.repeat(256)}${block}`;
    const belowCap = `${block}${stray.repeat(255)}${block}`;
    const scan = findTopLevelJsonBlocks(text);
    const fullScan = findTopLevelJsonBlocks(belowCap);

    expect(scan.blocks.map((found) => found.start)).toEqual([0]);
    expect(scan.stoppedAt).toBe(block.length + stray.length * 255);
    // `{{jsonBlock}}` reads no block from the rest.
    expect(findJsonBlocks(text).map((found) => found.start)).toEqual([0]);
    // One rejection fewer, and the scan reaches the end.
    expect(fullScan.blocks.map((found) => found.start)).toEqual([0, belowCap.lastIndexOf(block)]);
    expect(fullScan.stoppedAt).toBe(belowCap.length);
  });
});

describe("protectJsonBlocks", () => {
  test("leaves text without valid blocks alone", () => {
    const text = "<json>{{getchatvar::state}}</json> {{user}}";
    const protection = protectJsonBlocks(text, makeEnv());

    expect(protection.text).toBe(text);
    expect(protection.restore("{{user}}")).toBe("{{user}}");
  });

  test("swaps each block for a placeholder of digits between NULs", () => {
    const parts = protectJsonBlocks('A <json>{"a":"{{user}}"}</json> B <json>[1]</json> C', makeEnv()).text.split(" ");

    expect(parts).toHaveLength(5);
    expect([parts[0], parts[2], parts[4]]).toEqual(["A", "B", "C"]);
    expect(parts[1]).not.toBe(parts[3]);
    for (const placeholder of [parts[1], parts[3]]) {
      // Nothing a macro pass matches, and nothing {{upper}} or {{lower}} changes.
      expect(placeholder).toMatch(/^\x00\d+\x00$/);
    }
  });

  test("gives every block its own placeholder, identical or not", () => {
    const env = makeEnv();
    const block = '<json>"key"</json>';
    const protection = protectJsonBlocks(`${block}|${block}`, env);
    const [first, second] = protection.text.split("|");

    expect(second).not.toBe(first);
    expect(protection.restore(`${second}${first}`)).toBe(`${block}${block}`);
    // A later protection on the env makes new ones.
    expect(protectJsonBlocks(block, env).text).not.toBe(first);
  });

  test("holds out only blocks outside every macro tag", () => {
    const block = '<json>"key"</json>';
    const text = `{{setchatvar::${block}::value}}${block}`;
    const protection = protectJsonBlocks(text, makeEnv());

    expect(protection.text).toMatch(/^\{\{setchatvar::<json>"key"<\/json>::value\}\}\x00\d+\x00$/);
    expect(protection.restore(protection.text)).toBe(text);
  });

  test("reports a block scan that reached the rejection cap and holds nothing out", () => {
    const block = '<json>{"a":1}</json>';
    const stray = "<json>bad</json>";
    const text = `${block}${stray.repeat(256)}${block}`;
    const capped = protectJsonBlocks(text, makeEnv());
    // One rejection fewer, and the scan classifies the whole text.
    const full = protectJsonBlocks(`${block}${stray.repeat(255)}${block}`, makeEnv());

    expect(capped.capped).toBe(true);
    expect(capped.text).toBe(text);
    expect(full.capped).toBe(false);
    expect(full.text).toMatch(/^\x00\d+\x00(<json>bad<\/json>){255}\x00\d+\x00$/);
  });

  test("restores every placeholder occurrence, whether duplicated or dropped", () => {
    const first = '<json>{"a":1}</json>';
    const second = "<json>[2]</json>";
    const protection = protectJsonBlocks(`${first}|${second}`, makeEnv());
    const [a, b] = protection.text.split("|");

    expect(protection.restore(`${b}${a}${b}`)).toBe(`${second}${first}${second}`);
    expect(protection.restore(`only ${a}`)).toBe(`only ${first}`);
    expect(protection.restore("")).toBe("");
  });

  test("restores placeholders from every protection on the same env", () => {
    const env = makeEnv();
    const one = protectJsonBlocks("<json>1</json>", env);
    const two = protectJsonBlocks("<json>2</json>", env);

    expect(one.restore(`${two.text}${one.text}`)).toBe("<json>2</json><json>1</json>");
  });
});

describe("resolveJsonBlockPlaceholders", () => {
  test("resolves a placeholder for as long as its env lives", () => {
    const env = makeEnv();
    const block = '<json>{"a":1}</json>';
    const protection = protectJsonBlocks(block, env);
    protection.restore(protection.text);

    expect(resolveJsonBlockPlaceholders(`${protection.text}|${protection.text}`, env)).toBe(`${block}|${block}`);
    expect(resolveJsonBlockPlaceholders("plain", env)).toBe("plain");
  });

  test("an unrelated env cannot resolve another env's live placeholder", () => {
    const owner = makeEnv();
    const placeholder = protectJsonBlocks("<json>[1]</json>", owner).text;
    const unrelated = makeEnv();
    protectJsonBlocks("<json>[2]</json>", unrelated);

    expect(resolveJsonBlockPlaceholders(placeholder, unrelated)).toBe(placeholder);
    expect(readJsonInput(placeholder, unrelated)).toBe(placeholder);
    expect(resolveJsonBlockPlaceholders(placeholder, owner)).toBe("<json>[1]</json>");
  });

  test("a stray NUL and digits right before a placeholder do not hide it", () => {
    const env = makeEnv();
    const placeholder = protectJsonBlocks("<json>[1]</json>", env).text;
    // A literal-brace sentinel ends in a NUL, so `}12` before a block reads so.
    const text = `${LITERAL_BRACE_CLOSE}12${placeholder}`;

    expect(resolveJsonBlockPlaceholders(text, env)).toBe(`${LITERAL_BRACE_CLOSE}12<json>[1]</json>`);
  });
});

describe("readJsonInput", () => {
  test("resolves placeholders, then reads brace encodings as braces", () => {
    const env = makeEnv();
    const placeholder = protectJsonBlocks('<json>{"a":1}</json>', env).text;

    expect(readJsonInput(`${placeholder} ${LITERAL_BRACE_OPEN}${LITERAL_BRACE_CLOSE}`, env)).toBe(
      '<json>{"a":1}</json> {}',
    );
  });
});

describe("withJsonBlocksProtected", () => {
  test("restores the output as written and stored variables as inert JSON", async () => {
    const env = makeEnv();
    const block = '<json>{ "note": "{{setvar::x::y}} <user>", "hp": 1 }</json>';
    let seen = "";
    let resolvedInPass = "";

    const output = await withJsonBlocksProtected(`hp ${block}`, env, async (text) => {
      seen = text;
      resolvedInPass = resolveJsonBlockPlaceholders(text, env);
      env.variables.chat.set("state", text.slice("hp ".length));
      return `[${text}]`;
    });

    expect(seen).not.toContain("<json>");
    expect(resolvedInPass).toBe(`hp ${block}`);
    expect(output).toBe(`[hp ${block}]`);
    expect(env.variables.chat.get("state")).toBe(
      String.raw`<json>{ "note": "\u007b\u007bsetvar::x::y\u007d\u007d \u003cuser>", "hp": 1 }</json>`,
    );
    expect(env._chatVarsDirty).toBe(true);
  });

  test("restores a placeholder in a variable name to the block exactly as written", async () => {
    const env = makeEnv();
    const block = '<json>"{k}"</json>';

    // As `{{setchatvar::{{getchatvar::state}}::value}}` does once a scoped
    // setter has captured the block into `state` in the same pass.
    await withJsonBlocksProtected(block, env, async (text) => {
      env.variables.chat.set(text, "value");
      env.variables.local.set(`${text}!`, text);
      return "";
    });

    expect([...env.variables.chat]).toEqual([[block, "value"]]);
    // A value still gets the block as inert JSON.
    expect([...env.variables.local]).toEqual([[`${block}!`, String.raw`<json>"\u007bk\u007d"</json>`]]);
    expect(env._chatVarsDirty).toBe(true);
  });

  test("keeps distinct spellings of a restored name distinct", async () => {
    const env = makeEnv();
    const escaped = String.raw`<json>"\u0061"</json>`;

    await withJsonBlocksProtected(`<json>"a"</json>|${escaped}`, env, async (text) => {
      for (const [i, placeholder] of text.split("|").entries()) env.variables.chat.set(placeholder, String(i));
      return "";
    });

    expect([...env.variables.chat]).toEqual([
      ['<json>"a"</json>', "0"],
      [escaped, "1"],
    ]);
  });

  test("a pass over content without blocks still restores the env's placeholders", async () => {
    const env = makeEnv();
    const placeholder = protectJsonBlocks("<json>[1]</json>", env).text;
    env.variables.global.set("copy", placeholder);

    const output = await withJsonBlocksProtected("no blocks", env, async (text) => `${text} ${placeholder}`);

    expect(output).toBe("no blocks <json>[1]</json>");
    expect(env.variables.global.get("copy")).toBe("<json>[1]</json>");
  });

  test("runs no pass over content whose block scan reached the rejection cap", async () => {
    const env = makeEnv();
    const content = `${"<json>bad</json>".repeat(256)}<json>[1]</json>`;
    let ran = false;

    const output = await withJsonBlocksProtected(content, env, async (text) => {
      ran = true;
      return text;
    });

    expect(ran).toBe(false);
    expect(output).toBe(content);
  });

  test("restores variables even when the pass throws", async () => {
    const env = makeEnv();
    const failed = withJsonBlocksProtected('<json>{"a":"{b}"}</json>', env, async (text) => {
      env.variables.local.set("state", text);
      throw new Error("pass failed");
    });

    await expect(failed).rejects.toThrow("pass failed");
    expect(env.variables.local.get("state")).toBe(String.raw`<json>{"a":"\u007bb\u007d"}</json>`);
    expect(env._chatVarsDirty).toBeUndefined();
  });
});
