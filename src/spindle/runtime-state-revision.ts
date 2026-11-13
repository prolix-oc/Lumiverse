import { AsyncLocalStorage } from 'node:async_hooks';

export interface RuntimeStateRevision { epoch: string; sequence: number }
const mutation = new AsyncLocalStorage<{ userId: string; id: string }>();
export function withRuntimeMutation<T>(userId: string, id: string, run: () => T): T { return mutation.run({ userId, id }, run); }
export function runtimeMutationId(userId?: string): string | undefined { const value = mutation.getStore(); return value?.userId === userId ? value?.id : undefined; }

const epoch = crypto.randomUUID();
const revisions = new Map<string, number>();
const stateEvents = new Set([
  'CHAT_CHANGED', 'CHAT_DELETED', 'MESSAGE_SENT', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
  'CHARACTER_EDITED', 'CHARACTER_DELETED', 'PERSONA_CHANGED', 'SETTINGS_UPDATED',
  'WORLD_BOOK_CHANGED', 'WORLD_BOOK_DELETED', 'WORLD_BOOK_ENTRY_CHANGED', 'WORLD_BOOK_ENTRY_DELETED',
  'SPINDLE_BATCH_CHANGED',
]);

export function runtimeStateRevision(userId: string): RuntimeStateRevision {
  return { epoch, sequence: revisions.get(userId) ?? 0 };
}

export function advanceRuntimeStateRevision(event: string, userId?: string): RuntimeStateRevision | undefined {
  if (!userId || !stateEvents.has(event)) return;
  revisions.set(userId, (revisions.get(userId) ?? 0) + 1);
  return runtimeStateRevision(userId);
}
