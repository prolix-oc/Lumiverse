import { randomUUID } from "node:crypto";

export interface VariableValues { global: Record<string, string>; chat: Record<string, string> }
export interface VariableEffect { scope: "global" | "chat"; key: string; before: string | null; after: string | null }
export interface VariableCheckpointEntry extends VariableEffect { epoch: string }
export type VariableCheckpoint = VariableCheckpointEntry[];
export interface VariableStateSeed { values: VariableValues; checkpoint: VariableCheckpoint; epoch: string }

export function readVariableValues(metadata: Record<string, any>): VariableValues {
  const map = (value: unknown) => Object.fromEntries(value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([key, entry]) => [key, String(entry)]) : []);
  return { global: map(metadata.macro_variables?.global), chat: map(metadata.chat_variables) };
}

function value(values: VariableValues, scope: "global" | "chat", key: string): string | null {
  return Object.hasOwn(values[scope], key) ? values[scope][key]! : null;
}
const identity = (entry: VariableEffect) => JSON.stringify([entry.scope, entry.key]);

export function variableEffects(before: VariableValues, after: VariableValues): VariableEffect[] {
  return (["global", "chat"] as const).flatMap(scope => [...new Set([...Object.keys(before[scope]), ...Object.keys(after[scope])])]
    .filter(key => value(before, scope, key) !== value(after, scope, key))
    .map(key => ({ scope, key, before: value(before, scope, key), after: value(after, scope, key) })));
}

export function advanceVariableCheckpoint(checkpoint: VariableCheckpoint, effects: VariableEffect[], epoch: string = randomUUID()): VariableCheckpoint {
  const entries = new Map(checkpoint.map(entry => [identity(entry), entry]));
  for (const effect of effects) {
    const prior = entries.get(identity(effect));
    entries.set(identity(effect), prior && prior.after === effect.before
      ? { ...prior, after: effect.after }
      : { ...effect, epoch });
  }
  return [...entries.values()];
}

/** External writes start an epoch so later undo cannot cross that edit, including an ABA change. */
export function observeVariableChanges(checkpoint: VariableCheckpoint, before: VariableValues, after: VariableValues): VariableCheckpoint {
  const entries = new Map(checkpoint.map(entry => [identity(entry), entry]));
  const epoch = randomUUID();
  for (const effect of variableEffects(before, after)) {
    entries.set(identity(effect), { ...effect, epoch, before: effect.after });
  }
  return [...entries.values()];
}

export function restoreVariableCheckpoint(current: VariableValues, head: VariableCheckpoint, target: VariableCheckpoint): { values: VariableValues; checkpoint: VariableCheckpoint } {
  const entries = new Map(head.map(entry => [identity(entry), entry]));
  const desired = new Map(target.map(entry => [identity(entry), entry]));
  const maps = { global: new Map(Object.entries(current.global)), chat: new Map(Object.entries(current.chat)) };
  const result: VariableCheckpoint = [];
  for (const key of new Set([...entries.keys(), ...desired.keys()])) {
    let prior = entries.get(key);
    const next = desired.get(key);
    const sample = prior ?? next!;
    const actual = value(current, sample.scope, sample.key);
    // Direct database writers may not have passed through the metadata API.
    if (prior && actual !== prior.after) prior = { ...prior, epoch: randomUUID(), before: actual, after: actual };
    let entry: VariableCheckpointEntry;
    if (prior) entry = next?.epoch === prior.epoch ? next : { ...prior, after: prior.before };
    else entry = actual === next!.before || actual === next!.after ? next! : { ...next!, epoch: randomUUID(), before: actual, after: actual };
    if (entry.after === null) maps[entry.scope].delete(entry.key); else maps[entry.scope].set(entry.key, entry.after);
    result.push(entry);
  }
  return { values: { global: Object.fromEntries(maps.global), chat: Object.fromEntries(maps.chat) }, checkpoint: result };
}

export function withVariableValues(metadata: Record<string, any>, values: VariableValues): Record<string, any> {
  const maps = { global: new Map(Object.entries(metadata.macro_variables?.global ?? {})), chat: new Map(Object.entries(metadata.chat_variables ?? {})) };
  for (const effect of variableEffects(readVariableValues(metadata), values)) {
    if (effect.after === null) maps[effect.scope].delete(effect.key); else maps[effect.scope].set(effect.key, effect.after);
  }
  return { ...metadata, macro_variables: { ...metadata.macro_variables, global: Object.fromEntries(maps.global) }, chat_variables: Object.fromEntries(maps.chat) };
}
