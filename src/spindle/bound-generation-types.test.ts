import { describe, expect, test } from "bun:test";
import {
  BOUND_MAX_CARRIER_BYTES,
  BOUND_MAX_RETRIEVAL_BYTES,
  HostContainmentFatal,
  brandHostGenerationId,
  brandInvocationToken,
  cloneAndFreeze,
  computeBoundDeadlineWindow,
  deepFreeze,
  isHostContainmentFatal,
  normalizeUsage,
  stableJson,
  validateBoundDeadline,
} from "./bound-generation-types";

describe("Host-only type utilities", () => {
  test("canonical JSON is insertion-order independent but preserves arrays", () => {
    expect(stableJson({ z: 1, nested: { b: true, a: "x" }, list: ["second", "first"] })).toBe(
      '{"list":["second","first"],"nested":{"a":"x","b":true},"z":1}',
    );
    expect(stableJson({ omitted: undefined, finite: 2, infinity: Infinity, nan: Number.NaN })).toBe(
      '{"finite":2,"infinity":"Infinity","nan":"NaN"}',
    );
    expect(stableJson({ map: new Map([["z", 1], ["a", 2]]), set: new Set(["z", "a"]) })).toBe(
      '{"map":[["a",2],["z",1]],"set":["a","z"]}',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableJson(cyclic)).toThrow("cyclic");
  });

  test("cloneAndFreeze clones nested state, enforces caps, and freezes collections", () => {
    const original = {
      messages: [{ role: "user", content: "before" }],
      nested: { enabled: true },
      map: new Map([["key", { value: 1 }]]),
      set: new Set(["one"]),
    };
    const snapshot = cloneAndFreeze(original);
    original.messages[0].content = "after";
    original.nested.enabled = false;
    original.map.set("other", { value: 2 });
    original.set.add("two");
    expect({ messages: snapshot.messages, nested: snapshot.nested }).toEqual({
      messages: [{ role: "user", content: "before" }],
      nested: { enabled: true },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
    expect(Object.isFrozen(snapshot.map)).toBe(true);
    expect(Object.isFrozen(snapshot.set)).toBe(true);
    expect(() => (snapshot.messages as Array<{ role: string; content: string }>)[0].content = "mutated").toThrow();
    expect(() => snapshot.map.set("blocked", { value: 2 })).toThrow("immutable");
    expect(() => snapshot.set.add("blocked")).toThrow("immutable");
    expect(() => snapshot.map.delete("key")).toThrow("immutable");
    expect(() => snapshot.map.clear()).toThrow("immutable");
    expect(() => snapshot.set.delete("one")).toThrow("immutable");
    expect(() => snapshot.set.clear()).toThrow("immutable");
    expect([...snapshot.map.entries()]).toEqual([["key", { value: 1 }]]);
    expect([...snapshot.set.values()]).toEqual(["one"]);
    expect(() => Map.prototype.set.call(snapshot.map as Map<unknown, unknown>, "bypass", 1)).toThrow();
    expect(() => snapshot.map.forEach((_value, _key, collection) => collection.set("forEach", { value: 3 }))).toThrow("immutable");
    expect(() => snapshot.set.forEach((_value, _key, collection) => collection.add("forEach"))).toThrow("immutable");
    expect(snapshot.map.valueOf()).toBe(snapshot.map);
    expect(snapshot.set.valueOf()).toBe(snapshot.set);
    expect(() => cloneAndFreeze({ payload: "x".repeat(BOUND_MAX_RETRIEVAL_BYTES) })).toThrow(`${BOUND_MAX_RETRIEVAL_BYTES} bytes`);
    expect(() => cloneAndFreeze({ payload: "x".repeat(BOUND_MAX_CARRIER_BYTES + 1) }, BOUND_MAX_CARRIER_BYTES)).toThrow();
  });

  test("deepFreeze protects pre-existing maps and sets", () => {
    const value = { map: new Map([["key", { value: 1 }]]), set: new Set([{ value: 2 }]) };
    const frozen = deepFreeze(value);
    expect(Object.isFrozen(frozen.map)).toBe(true);
    expect(Object.isFrozen(frozen.set)).toBe(true);
    expect(() => frozen.map.set("other", { value: 3 })).toThrow("immutable");
    expect(() => frozen.map.delete("key")).toThrow("immutable");
    expect(() => frozen.set.add({ value: 4 })).toThrow("immutable");
    expect(() => frozen.set.clear()).toThrow("immutable");
    expect([...frozen.map.entries()]).toEqual([["key", { value: 1 }]]);
  });

  test("normalizes usage immutably and keeps receipts free of mutable provider objects", () => {
    const providerRaw = { request: { id: "one" }, tags: ["a", "b"] };
    const usage = normalizeUsage({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, provider_raw: providerRaw });
    providerRaw.request.id = "changed";
    providerRaw.tags.push("c");
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, provider_raw: { request: { id: "one" }, tags: ["a", "b"] } });
    expect(Object.isFrozen(usage)).toBe(true);
    expect(Object.isFrozen(usage?.provider_raw)).toBe(true);
    expect(normalizeUsage(undefined)).toBeUndefined();
  });

  test("computes and validates the callback work window", () => {
    const window = computeBoundDeadlineWindow(1_000, 40_000);
    expect(window).toEqual({ entryAt: 1_000, interceptorDeadlineAt: 40_000, boundWorkDeadlineAt: 25_000 });
    expect(Object.isFrozen(window)).toBe(true);
    expect(validateBoundDeadline(1_001, 1_000, window.boundWorkDeadlineAt)).toEqual({ ok: true });
    expect(validateBoundDeadline(1_000, 1_000, window.boundWorkDeadlineAt)).toMatchObject({ ok: false, code: "DEADLINE_EXPIRED" });
    expect(validateBoundDeadline(25_001, 1_000, window.boundWorkDeadlineAt)).toMatchObject({ ok: false, code: "DEADLINE_OVERLONG" });
    expect(validateBoundDeadline(Number.NaN, 1_000, window.boundWorkDeadlineAt)).toMatchObject({ ok: false, code: "DEADLINE_INVALID" });
    expect(() => computeBoundDeadlineWindow(Number.NaN, 40_000)).toThrow("finite");
    expect(() => computeBoundDeadlineWindow(1_000, 15_500)).toThrow("no bound work window");
  });

  test("recognizes only host-created containment fatals", () => {
    const fatal = new HostContainmentFatal({
      code: "NONCOMMIT_CONTAINMENT_FAILED",
      message: "lease was not released",
      hostGeneration: brandHostGenerationId("generation-1"),
      workerId: "worker-1",
      requestId: "request-1",
    });
    expect(fatal.name).toBe("HostContainmentFatal");
    expect(isHostContainmentFatal(fatal)).toBe(true);
    expect(isHostContainmentFatal({ name: fatal.name, code: fatal.code })).toBe(false);
    expect(isHostContainmentFatal(new Error(fatal.message))).toBe(false);
    expect(String(brandInvocationToken("opaque-token"))).toBe("opaque-token");
  });
});
