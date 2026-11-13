import { expect, test } from "bun:test";
import { advanceVariableCheckpoint, observeVariableChanges, restoreVariableCheckpoint, variableEffects, withVariableValues, type VariableCheckpoint, type VariableValues } from "./variable-checkpoint";
const state = (count: string): VariableValues => ({ global: {}, chat: { count } });
const advance = (head: VariableCheckpoint, before: VariableValues, after: VariableValues) => advanceVariableCheckpoint(head, variableEffects(before, after));

test("checkpoints rewind multiple deleted replies without reading deleted messages", () => {
  const a = advance([], state("0"), state("1"));
  const b = advance(a, state("1"), state("2"));
  const c = advance(b, state("2"), state("3"));
  expect(restoreVariableCheckpoint(state("3"), c, a).values).toEqual(state("1"));
  expect(restoreVariableCheckpoint(state("3"), c, []).values).toEqual(state("0"));
});

test("rollback stops at external edits and retains barriers after a zero-net change", () => {
  const a = advance([], state("0"), state("1"));
  const b = advance(a, state("1"), state("2"));
  const manual = observeVariableChanges(b, state("2"), state("9"));
  const c = advance(manual, state("9"), state("10"));
  const restored = restoreVariableCheckpoint(state("10"), c, a);
  expect(restored.values).toEqual(state("9"));
  expect(restoreVariableCheckpoint(restored.values, restored.checkpoint, b).values).toEqual(state("9"));
  const next = advance(restored.checkpoint, state("9"), state("11"));
  expect(restoreVariableCheckpoint(state("11"), next, a).values).toEqual(state("9"));
});

test("external ABA writes remain protected when their value matches an older swipe", () => {
  const a = advanceVariableCheckpoint([], variableEffects(state("0"), state("1")), "shared");
  const alternate = advanceVariableCheckpoint([], variableEffects(state("0"), state("10")), "shared");
  expect(restoreVariableCheckpoint(state("1"), a, alternate).values).toEqual(state("10"));
  const changed = observeVariableChanges(a, state("1"), state("7"));
  const back = observeVariableChanges(changed, state("7"), state("1"));
  expect(restoreVariableCheckpoint(state("1"), back, alternate).values).toEqual(state("1"));
});

test("deleted keys, separate scopes and unusual names round trip without changing unrelated values", () => {
  const before = { global: { same: "old" }, chat: JSON.parse('{"same":"chat","__proto__":"keep"}') };
  const after = { global: {}, chat: { same: "new", added: "yes" } };
  const head = advance([], before, after);
  const restored = restoreVariableCheckpoint({ ...after, global: { external: "keep" } }, head, []);
  expect(restored.values).toEqual({ ...before, global: { same: "old", external: "keep" } });
  expect(withVariableValues({ chat_variables: { count: 12, other: false }, extra: true }, { global: {}, chat: { count: "12", other: "false", new: "x" } }))
    .toEqual({ chat_variables: { count: 12, other: false, new: "x" }, macro_variables: { global: {} }, extra: true });
});

test("external ABA writes protect keys that had no earlier checkpoint", () => {
  const seed = { global: {}, chat: { count: "1", untouched: "0" } };
  const head = advance([], state("0"), state("1"));
  const edited = { global: {}, chat: { ...seed.chat, untouched: "7" } };
  const changed = observeVariableChanges(head, seed, edited);
  const back = observeVariableChanges(changed, edited, seed);
  const delayed = advance(head, seed, { global: {}, chat: { count: "2", untouched: "1" } });
  expect(restoreVariableCheckpoint(seed, back, delayed).values).toEqual({ global: {}, chat: { count: "2", untouched: "0" } });
});
