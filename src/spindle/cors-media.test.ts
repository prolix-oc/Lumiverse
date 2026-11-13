import { describe, expect, test } from "bun:test";
import { isGenericBinaryContentType } from "./cors-media";

describe("isGenericBinaryContentType", () => {
  test("matches generic binary types, with or without parameters", () => {
    expect(isGenericBinaryContentType("application/octet-stream")).toBe(true);
    expect(isGenericBinaryContentType("application/octet-stream; charset=utf-8")).toBe(true);
    expect(isGenericBinaryContentType("binary/octet-stream")).toBe(true);
    expect(isGenericBinaryContentType("Application/Octet-Stream")).toBe(true);
  });

  test("does not match media or other types", () => {
    for (const type of ["font/woff2", "audio/mpeg", "image/png", "text/html", "application/javascript", "application/json", ""]) {
      expect(isGenericBinaryContentType(type)).toBe(false);
    }
  });
});
