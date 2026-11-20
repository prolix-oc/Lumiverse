import { describe, expect, test } from "bun:test";
import { clearMacroAstCache, parse } from "./MacroParser";

describe("MacroParser source boundaries", () => {
  test("distinguishes a real closing token from end-of-input recovery", () => {
    for (const source of ["{{unknown}}", "{{unknown::{{nested}}}}"]) {
      const node = parse(source)[0];
      expect(node.type).toBe("macro");
      if (node.type !== "macro") throw new Error("Expected macro node");
      expect(node.unterminated).toBeUndefined();
      expect(node.raw).toBe(source);
    }
    for (const source of ["{{unknown", "{{unknown}", "{{unknown::{{nested}}"]) {
      const node = parse(source)[0];
      expect(node.type).toBe("macro");
      if (node.type !== "macro") throw new Error("Expected macro node");
      expect(node.unterminated).toBe(true);
      expect(node.raw).toBe(source);
    }
  });
});

describe("MacroParser cache", () => {
  test("rebuilds parsed templates after a pressure release", () => {
    const first = parse("Hello, {{char}}!");
    expect(parse("Hello, {{char}}!")).toBe(first);

    clearMacroAstCache();

    expect(parse("Hello, {{char}}!")).not.toBe(first);
  });
});
