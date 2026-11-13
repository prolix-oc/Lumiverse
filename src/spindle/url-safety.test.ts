import { describe, expect, test } from "bun:test";

import {
  normalizeSpindleAppNavigationPath,
  normalizeSpindleHttpsUrl,
} from "./url-safety";

describe("normalizeSpindleAppNavigationPath", () => {
  test("keeps app-relative routes", () => {
    expect(normalizeSpindleAppNavigationPath("/#/chat/123")).toBe("/#/chat/123");
  });

  test("falls back for magic links and absolute origins", () => {
    expect(normalizeSpindleAppNavigationPath("vscode://file/foo")).toBe("/");
    expect(normalizeSpindleAppNavigationPath("https://example.com")).toBe("/");
    expect(normalizeSpindleAppNavigationPath("//evil.test/path")).toBe("/");
  });
});

describe("normalizeSpindleHttpsUrl", () => {
  test("accepts https manifest links", () => {
    expect(normalizeSpindleHttpsUrl("https://github.com/example/repo", "github")).toBe(
      "https://github.com/example/repo",
    );
  });

  test("rejects non-https manifest links", () => {
    expect(() => normalizeSpindleHttpsUrl("local://example", "github")).toThrow(
      "github URL must use https://",
    );
    expect(() => normalizeSpindleHttpsUrl("javascript:alert(1)", "homepage")).toThrow(
      "homepage URL must use https://",
    );
  });

  test("allows optional missing links", () => {
    expect(normalizeSpindleHttpsUrl(undefined, "homepage")).toBe("");
  });
});
