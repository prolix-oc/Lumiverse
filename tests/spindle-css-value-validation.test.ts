import { describe, expect, test } from "bun:test";
import { validateCssValue } from "../src/spindle/css-value-validation";

describe("Spindle CSS value validation", () => {
  test("accepts ordinary numeric color values", () => {
    for (const value of ["#ff0000", "#102030", "rgba(255, 0, 0, 0.5)", "oklch(62% 0.2 29)"]) expect(validateCssValue(value)).toBeNull();
  });

  test("rejects actual prohibited controls without rejecting surrounding CSS whitespace", () => {
    for (const code of [0, 1, 8, 11, 12, 14, 31]) expect(validateCssValue(`red${String.fromCharCode(code)}`)).toBe("control characters not allowed");
    expect(validateCssValue("\t#ff0000\r\n")).toBeNull();
  });
});
