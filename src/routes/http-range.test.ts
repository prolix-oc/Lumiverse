import { describe, expect, test } from "bun:test";
import { parseRangeHeader } from "./http-range";

describe("parseRangeHeader", () => {
  test("returns null when the header is missing", () => {
    expect(parseRangeHeader(undefined, 100)).toBeNull();
  });

  test("parses closed and open-ended ranges", () => {
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRangeHeader("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  });

  test("parses suffix ranges and clamps oversized ends", () => {
    expect(parseRangeHeader("bytes=-25", 100)).toEqual({ start: 75, end: 99 });
    expect(parseRangeHeader("bytes=90-999", 100)).toEqual({ start: 90, end: 99 });
  });

  test("treats multipart and malformed headers as a normal full-file fallback", () => {
    expect(parseRangeHeader("bytes=0-10,20-30", 100)).toBeNull();
    expect(parseRangeHeader("garbage", 100)).toBeNull();
  });

  test("rejects out-of-bounds and empty ranges", () => {
    expect(parseRangeHeader("bytes=100-100", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=-0", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=-", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=20-10", 100)).toBe("invalid");
  });
});
