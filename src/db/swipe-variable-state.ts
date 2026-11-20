import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { advanceVariableCheckpoint, observeVariableChanges, readVariableValues, restoreVariableCheckpoint, variableEffects, withVariableValues,
  type VariableCheckpoint, type VariableValues, type VariableStateSeed } from "../utils/variable-checkpoint";

export const SWIPE_VARIABLE_STATE_KEY = "_swipe_variable_state";
export interface SwipeVariableRecord { version: 1; id: string; epoch: string; before?: VariableStateSeed; values: VariableValues; checkpoint: VariableCheckpoint }
interface VariableTracking { version: 1; revision: string; epoch: string; head: VariableCheckpoint; messageId?: string; stateId?: string }
export interface VariableWriteSource { messageId: string; stateId: string; values: Partial<VariableValues>; replaceScopes?: ("global" | "chat")[] }
export interface SetSwipeVariablesInput { expected_variables: VariableValues; expected_revision: string | null; variables: VariableValues[]; expected_swipes: string[] }
export interface VariableBoundary { index: number; before: VariableStateSeed }
export interface ReconcileVariableOptions { selectedMessageId?: string; discarded?: VariableBoundary[] }

export function readVariableBoundary(extra: Record<string, any>, swipeId: number, index: number): VariableBoundary | undefined {
  const records = extra.variableStateBySwipe as (SwipeVariableRecord | null)[] | undefined;
  const before = records?.[swipeId]?.before ?? records?.find(record => record?.before)?.before;
  return before ? { index, before } : undefined;
}

/** Preserve checkpoints written by background metadata transactions after a message was read. */
export function preserveSwipeVariablesSql(extra: Record<string, any>, count: number, removedIndex?: number): string {
  if (!Array.isArray(extra.variableStateBySwipe)) return "?";
  if (!Number.isSafeInteger(count) || count < 1 || (removedIndex !== undefined && (!Number.isSafeInteger(removedIndex) || removedIndex < 0))) throw new Error("Invalid swipe bounds");
  const records = removedIndex === undefined ? "json_extract(extra, '$.variableStateBySwipe')"
    : `json_remove(json_extract(extra, '$.variableStateBySwipe'), '$[${removedIndex}]')`;
  return `json_set(?, '$.variableStateBySwipe', (SELECT json_group_array(json(value)) FROM json_each(${records}) WHERE key < ${count}))`;
}

function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function parse(text: string): Record<string, any> { const value = JSON.parse(text); return object(value) ? value : {}; }
function tracker(metadata: Record<string, any>): VariableTracking | undefined {
  const value = metadata[SWIPE_VARIABLE_STATE_KEY];
  if (value === undefined) return;
  if (!object(value) || value.version !== 1 || !Array.isArray(value.head)) throw new Error("Invalid saved swipe variable state");
  return value as VariableTracking;
}
export function readVariableStateSeed(metadata: Record<string, any>): VariableStateSeed {
  const tracking = tracker(metadata);
  return { values: readVariableValues(metadata), checkpoint: tracking?.head ?? [], epoch: tracking?.epoch ?? randomUUID() };
}

/** Regeneration starts before the original reply while retaining subsequent external edits. */
export function readGenerationVariableSeed(metadata: Record<string, any>, extra?: Record<string, any>, swipeId = 0, regenerate = false): VariableStateSeed {
  const current = readVariableStateSeed(metadata);
  const records = extra?.variableStateBySwipe as (SwipeVariableRecord | null)[] | undefined;
  const before = regenerate ? (records?.[swipeId]?.before ?? records?.find(record => record?.before)?.before) : undefined;
  if (!before) return current;
  const restored = restoreVariableCheckpoint(current.values, current.checkpoint, before.checkpoint);
  return { values: restored.values, checkpoint: restored.checkpoint, epoch: current.epoch };
}
function message(db: Database, chatId: string, messageId: string) {
  return db.query("SELECT * FROM messages WHERE id = ? AND chat_id = ?").get(messageId, chatId) as
    { id: string; is_user: number; index_in_chat: number; swipe_id: number; swipes: string; extra: string } | null;
}
function latestAssistant(db: Database, chatId: string) {
  return db.query("SELECT id FROM messages WHERE chat_id = ? AND is_user = 0 AND COALESCE(json_extract(extra, '$.spindle_role'), '') <> 'system' ORDER BY index_in_chat DESC LIMIT 1")
    .get(chatId) as { id: string } | null;
}
function latestMessage(db: Database, chatId: string) {
  return db.query("SELECT id, index_in_chat FROM messages WHERE chat_id = ? ORDER BY index_in_chat DESC LIMIT 1")
    .get(chatId) as { id: string; index_in_chat: number } | null;
}
function storeRecords(db: Database, messageId: string, extra: Record<string, any>, records: (SwipeVariableRecord | null)[]) {
  db.query("UPDATE messages SET extra = ? WHERE id = ?").run(JSON.stringify({ ...extra, variableStateBySwipe: records }), messageId);
}

/** Called inside the chat metadata transaction; ordinary writes remain external edits. */
export function trackVariableWrite(db: Database, chatId: string, before: Record<string, any>, after: Record<string, any>, source?: VariableWriteSource): Record<string, any> {
  const tracking = tracker(before);
  if (!tracking) {
    if (Object.hasOwn(after, SWIPE_VARIABLE_STATE_KEY)) { const next = { ...after }; delete next[SWIPE_VARIABLE_STATE_KEY]; return next; }
    return after;
  }
  const current = readVariableValues(before);
  if (!source) {
    const next = readVariableValues(after);
    return { ...after, [SWIPE_VARIABLE_STATE_KEY]: { ...tracking,
      ...(variableEffects(current, next).length ? { revision: randomUUID() } : {}), head: observeVariableChanges(tracking.head, current, next) } };
  }
  const row = message(db, chatId, source.messageId);
  if (!row) throw new Error("The variable source message was deleted");
  const extra = parse(row.extra);
  const records = extra.variableStateBySwipe as (SwipeVariableRecord | null)[] | undefined;
  const index = records?.findIndex(record => record?.id === source.stateId) ?? -1;
  const record = records?.[index];
  if (!record || record.version !== 1 || index >= JSON.parse(row.swipes).length) throw new Error("The variable source swipe is unavailable");
  const values = { ...record.values };
  for (const scope of ["global", "chat"] as const) if (source.values[scope]) values[scope] = source.replaceScopes?.includes(scope)
    ? source.values[scope]! : { ...values[scope], ...source.values[scope] };
  const checkpoint = advanceVariableCheckpoint(record.checkpoint, variableEffects(record.values, values), record.epoch);
  records![index] = { ...record, values, checkpoint };
  storeRecords(db, row.id, extra, records!);
  if (row.swipe_id !== index || latestMessage(db, chatId)?.id !== row.id) {
    return { ...withVariableValues(after, current), [SWIPE_VARIABLE_STATE_KEY]: tracking };
  }
  const restored = restoreVariableCheckpoint(current, tracking.head, checkpoint);
  return { ...withVariableValues(after, restored.values), [SWIPE_VARIABLE_STATE_KEY]: {
    version: 1, revision: randomUUID(), epoch: tracking.epoch, head: restored.checkpoint, messageId: row.id, stateId: record.id,
  } satisfies VariableTracking };
}

export function prepareNativeSwipeVariablesWithDb(db: Database, userId: string, chatId: string, messageId: string, swipeId: number, seed?: VariableStateSeed, stateId?: string, preserveBefore = false): string | undefined {
  return db.transaction(() => {
    const chat = db.query("SELECT metadata FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId) as { metadata: string } | null;
    if (!chat) return;
    const metadata = parse(chat.metadata);
    let tracking = tracker(metadata);
    const row = message(db, chatId, messageId);
    if (!row || row.is_user) throw new Error("Invalid variable source message");
    const extra = parse(row.extra), records = Array.from({ length: JSON.parse(row.swipes).length }, (_, i) => extra.variableStateBySwipe?.[i] ?? null);
    const index = stateId ? records.findIndex(record => record?.id === stateId) : swipeId;
    if (index < 0 || index >= records.length) throw new Error("The variable source swipe was deleted");
    const initial = seed ?? readVariableStateSeed(metadata);
    if (!tracking) {
      tracking = { version: 1, revision: randomUUID(), epoch: initial.epoch,
        head: observeVariableChanges(initial.checkpoint, initial.values, readVariableValues(metadata)) };
    }
    const prior = records[index] as SwipeVariableRecord | null;
    const id = stateId ?? prior?.id ?? randomUUID();
    records[index] = { version: 1, id, epoch: initial.epoch, before: (!seed || preserveBefore ? prior?.before : undefined) ?? initial,
      values: initial.values, checkpoint: initial.checkpoint } satisfies SwipeVariableRecord;
    storeRecords(db, row.id, extra, records);
    let next = { ...metadata, [SWIPE_VARIABLE_STATE_KEY]: tracking };
    if (row.swipe_id === index && latestMessage(db, chatId)?.id === row.id) {
      const restored = restoreVariableCheckpoint(readVariableValues(metadata), tracking.head, initial.checkpoint);
      next = { ...withVariableValues(metadata, restored.values), [SWIPE_VARIABLE_STATE_KEY]: {
        ...tracking, head: restored.checkpoint, messageId: row.id, stateId: id,
      } };
    }
    if (!isDeepStrictEqual(metadata, next)) {
      next[SWIPE_VARIABLE_STATE_KEY].revision = randomUUID();
      db.query("UPDATE chats SET metadata = ? WHERE id = ? AND user_id = ?")
        .run(JSON.stringify(next), chatId, userId);
    }
    return id;
  }).immediate();
}

export function setSwipeVariablesWithDb(db: Database, userId: string, chatId: string, messageId: string, input: SetSwipeVariablesInput): boolean {
  return db.transaction(() => {
    const chat = db.query("SELECT metadata FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId) as { metadata: string } | null;
    if (!chat) throw new Error("Chat not found");
    const metadata = parse(chat.metadata), current = readVariableValues(metadata);
    const row = message(db, chatId, messageId);
    if (!row || row.is_user || latestMessage(db, chatId)?.id !== row.id) throw new Error("Swipe variables require an assistant message at the end of the chat");
    const swipes = JSON.parse(row.swipes);
    const tracking = tracker(metadata);
    if (!isDeepStrictEqual(current, input.expected_variables) || !isDeepStrictEqual(swipes, input.expected_swipes) || (tracking?.revision ?? null) !== input.expected_revision) return false;
    if (input.variables.length !== swipes.length) throw new Error("Variable states must match the swipe count");
    const epoch = tracking?.epoch ?? randomUUID();
    const extra = parse(row.extra);
    if (Array.isArray(extra.variableStateBySwipe) && extra.variableStateBySwipe.some(Boolean)) throw new Error("This message already has saved swipe variables");
    const before = { values: current, checkpoint: tracking?.head ?? [], epoch };
    const records = input.variables.map(values => ({ version: 1 as const, id: randomUUID(), epoch, before, values,
      checkpoint: advanceVariableCheckpoint(tracking?.head ?? [], variableEffects(current, values), epoch) }));
    storeRecords(db, row.id, extra, records);
    const selected = records[row.swipe_id]!;
    const restored = restoreVariableCheckpoint(current, tracking?.head ?? [], selected.checkpoint);
    const next = { ...withVariableValues(metadata, restored.values), [SWIPE_VARIABLE_STATE_KEY]: {
      version: 1, revision: randomUUID(), epoch, head: restored.checkpoint, messageId: row.id, stateId: selected.id,
    } satisfies VariableTracking };
    db.query("UPDATE chats SET metadata = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(next), chatId, userId);
    return true;
  }).immediate();
}

export function reconcileSwipeVariablesWithDb(db: Database, userId: string, chatId: string, options: ReconcileVariableOptions = {}): { before: Record<string, any>; after: Record<string, any> } | null {
  return db.transaction(() => {
    const end = latestMessage(db, chatId);
    if (options.selectedMessageId && end?.id !== options.selectedMessageId) return null;
    const chat = db.query("SELECT metadata FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId) as { metadata: string } | null;
    if (!chat) return null;
    const before = parse(chat.metadata), tracking = tracker(before);
    if (!tracking) return null;
    const last = latestAssistant(db, chatId);
    const boundary = end && end.id !== last?.id ? options.discarded
      ?.filter(value => value.index > end.index_in_chat).sort((a, b) => a.index - b.index)[0]?.before : undefined;
    if (end && end.id !== last?.id && !boundary && (!tracking.messageId || message(db, chatId, tracking.messageId))) return null;
    let row = last && message(db, chatId, last.id);
    let record = row ? parse(row.extra).variableStateBySwipe?.[row.swipe_id] as SwipeVariableRecord | undefined : undefined;
    if (!record && !boundary && tracking.messageId && message(db, chatId, tracking.messageId)) return null;
    if (!record) {
      const tracked = db.query("SELECT id FROM messages WHERE chat_id = ? AND is_user = 0 AND COALESCE(json_extract(extra, '$.spindle_role'), '') <> 'system' AND json_extract(extra, '$.variableStateBySwipe[' || swipe_id || '].version') = 1 ORDER BY index_in_chat DESC LIMIT 1")
        .get(chatId) as { id: string } | null;
      row = tracked && message(db, chatId, tracked.id);
      record = row ? parse(row.extra).variableStateBySwipe[row.swipe_id] : undefined;
    }
    const restored = restoreVariableCheckpoint(readVariableValues(before), tracking.head, boundary?.checkpoint ?? record?.checkpoint ?? []);
    const nextTracking: VariableTracking = { version: 1, revision: tracking.revision, epoch: tracking.epoch, head: restored.checkpoint,
      ...(!boundary && record && row ? { messageId: row.id, stateId: record.id } : {}) };
    const after = { ...withVariableValues(before, restored.values), [SWIPE_VARIABLE_STATE_KEY]: nextTracking };
    if (isDeepStrictEqual(before, after)) return null;
    nextTracking.revision = randomUUID();
    db.query("UPDATE chats SET metadata = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(after), chatId, userId);
    return { before, after };
  }).immediate();
}

/** Copies keep state IDs while replacing message IDs. Repair ownership without replaying effects. */
export function remapSwipeVariableOwnerWithDb(db: Database, userId: string, chatId: string): void {
  db.transaction(() => {
    const chat = db.query("SELECT metadata FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId) as { metadata: string } | null;
    const tracking = chat && tracker(parse(chat.metadata));
    if (!tracking?.stateId || (tracking.messageId && message(db, chatId, tracking.messageId))) return;
    const owners = db.query("SELECT m.id FROM messages m, json_each(m.extra, '$.variableStateBySwipe') s WHERE m.chat_id = ? AND json_extract(s.value, '$.id') = ? LIMIT 2")
      .all(chatId, tracking.stateId) as { id: string }[];
    if (owners.length > 1) throw new Error("Duplicate swipe variable owner");
    if (owners.length) db.query("UPDATE chats SET metadata = json_set(metadata, '$._swipe_variable_state.messageId', ?) WHERE id = ? AND user_id = ?")
      .run(owners[0]!.id, chatId, userId);
  }).immediate();
}
