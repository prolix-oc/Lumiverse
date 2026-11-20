import { describe, expect, test } from "bun:test";
import { parseStrictInteger } from "./strict-integer";

describe("parseStrictInteger", () => {
  test("rejects partial, decimal, and empty values", () => {
    expect(parseStrictInteger("7860abc")).toBeUndefined();
    expect(parseStrictInteger("12.5")).toBeUndefined();
    expect(parseStrictInteger("")).toBeUndefined();
    expect(parseStrictInteger(undefined)).toBeUndefined();
  });

  test("accepts signed base-10 integers and trims whitespace", () => {
    expect(parseStrictInteger("  +80 ")).toBe(80);
    expect(parseStrictInteger("-12")).toBe(-12);
    expect(parseStrictInteger("0")).toBe(0);
  });

  test("rejects unsafe integers", () => {
    expect(parseStrictInteger("9007199254740992")).toBeUndefined();
  });
});