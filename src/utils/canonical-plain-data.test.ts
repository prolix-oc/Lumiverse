import { describe, expect, test } from "bun:test";
import {
  CanonicalDataError,
  cloneCanonicalPlainData,
  encodeCanonicalPlainData,
  validateCanonicalPlainData,
} from "./canonical-plain-data";

function diamondDag(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { v: 0 };
  for (let index = 1; index < levels; index += 1) {
    node = { l: node, r: node };
  }
  return node;
}

function expectLimit(run: () => unknown, dimension: "nodes" | "bytes"): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CanonicalDataError);
  const error = failure as CanonicalDataError;
  expect(error.code).toBe("limit_exceeded");
  expect(error.dimension).toBe(dimension);
}

describe("canonical plain-data walk bounds", () => {
  test("encodes deterministic key order", () => {
    expect(encodeCanonicalPlainData({ z: 1, a: { d: 4, b: 2 }, m: [3, 1] })).toBe(
      "{\"a\":{\"b\":2,\"d\":4},\"m\":[3,1],\"z\":1}",
    );
    expect(encodeCanonicalPlainData({ a: 1, z: 2 })).toBe(encodeCanonicalPlainData({ z: 2, a: 1 }));
  });

  test("orders non-ASCII keys by raw UTF-8 bytes", () => {
    expect(encodeCanonicalPlainData({ "é": 2, z: 1 })).toBe("{\"z\":1,\"é\":2}");
  });

  test("distinguishes lone surrogate and replacement-character keys", () => {
    const loneSurrogate = "\uD800";
    const replacementCharacter = "\uFFFD";
    const first = { [loneSurrogate]: 1, [replacementCharacter]: 2 };
    const second = { [replacementCharacter]: 2, [loneSurrogate]: 1 };

    const encoded = encodeCanonicalPlainData(first);
    expect(encoded).toBe(encodeCanonicalPlainData(second));
    expect(encoded).toBe("{\"\\ud800\":1,\"�\":2}");
  });

  test("aborts a diamond DAG at cap plus one node instead of expanding it", () => {
    const started = Date.now();
    expectLimit(() => validateCanonicalPlainData(diamondDag(40), { maxNodes: 100 }), "nodes");
    expectLimit(() => cloneCanonicalPlainData(diamondDag(40), { maxNodes: 100 }), "nodes");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("aborts a wide object before inspecting cap plus one keys", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 101; index += 1) wide[`k${index}`] = index;
    const started = Date.now();
    expectLimit(() => validateCanonicalPlainData(wide, { maxNodes: 100 }), "nodes");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("rejects a string that already exceeds the byte cap before escaping it", () => {
    const started = Date.now();
    expectLimit(() => validateCanonicalPlainData("x".repeat(32), { maxBytes: 16 }), "bytes");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("clones a 132KB tree inside the default caps", () => {
    const payload = {
      kind: "regenerate",
      messages: Array.from({ length: 129 }, (_value, index) => ({
        id: `m-${index}`,
        text: "n".repeat(1024),
      })),
    };
    const started = Date.now();
    const cloned = cloneCanonicalPlainData(payload);
    expect(cloned).toEqual(payload);
    expect(cloned).not.toBe(payload);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
