import { describe, expect, test } from "bun:test";
import { __test__ } from "./import.service";

describe("secret index bounds", () => {
  test("rejects an oversized key list before creating an expected-key set", () => {
    const keys = Array.from({ length: 10_001 }, (_, index) => `secret-${index}`);
    expect(() => __test__.validateSecretIndex(keys)).toThrow("secret index exceeds entry cap");
  });

  test("rejects a key that exceeds the per-key UTF-8 bound", () => {
    expect(() => __test__.validateSecretIndex(["x".repeat(4_097)])).toThrow(
      "secret index exceeds byte cap",
    );
  });
  test("rejects aggregate key bytes before retaining a large index", () => {
    const suffix = "x".repeat(4_092);
    const keys = Array.from(
      { length: 4_097 },
      (_, index) => `${index.toString(36).padStart(4, "0")}${suffix}`,
    );
    expect(() => __test__.validateSecretIndex(keys)).toThrow("secret index exceeds byte cap");
  });

  test("rejects duplicate keys and returns validated keys unchanged", () => {
    expect(() => __test__.validateSecretIndex(["same", "same"])).toThrow(
      "secret index has duplicate keys",
    );
    const keys = ["alpha", "βeta"];
    expect(__test__.validateSecretIndex(keys)).toBe(keys);
  });
});
