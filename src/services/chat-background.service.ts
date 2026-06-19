/**
 * Per-chat background work controller.
 *
 * Fire-and-forget tasks that the generation pipeline kicks off (cortex cache
 * warming, databank retrieval, anything that outlives the hot path) attach
 * to this controller in addition to the generation's own `AbortController`.
 * That way:
 *
 *   - A user-initiated stop tears down both the hot path and the background
 *     tasks for the chat.
 *   - A newer generation arriving on the same chat aborts prior-generation
 *     orphans even when the prior generation completed successfully
 *     (successful completion doesn't abort its own controller — it just
 *     drops it from the active map — so orphan background work could
 *     otherwise accumulate across sends).
 *
 * Keep this module dependency-free so both the generation service and the
 * prompt assembly pipeline can import it without creating a cycle.
 */

const chatBackgroundControllers = new Map<string, AbortController>();

// Track pending background task promises so abort callers can await their
// HTTP teardown (reader.cancel, connection close) before starting new
// fetches. Without this, Bun's HTTPThread can see overlapping cancel+start
// operations that trigger a null-callback segfault.
const chatBackgroundTasks = new Map<string, Set<Promise<void>>>();

function chatBgKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

/**
 * Get (or lazily create) the abort signal for the chat's background work.
 * The returned signal stays stable until the chat's controller is aborted,
 * at which point the next call returns a fresh signal on a new controller.
 */
export function getChatBackgroundSignal(userId: string, chatId: string): AbortSignal {
  const key = chatBgKey(userId, chatId);
  let ctrl = chatBackgroundControllers.get(key);
  if (!ctrl || ctrl.signal.aborted) {
    ctrl = new AbortController();
    chatBackgroundControllers.set(key, ctrl);
  }
  return ctrl.signal;
}

/**
 * Register a background task promise so its HTTP teardown can be awaited
 * when the chat's background work is aborted. The task is automatically
 * removed from tracking once it settles.
 */
export function trackChatBackgroundTask(
  userId: string,
  chatId: string,
  task: Promise<void>,
): void {
  const key = chatBgKey(userId, chatId);
  let tasks = chatBackgroundTasks.get(key);
  if (!tasks) {
    tasks = new Set();
    chatBackgroundTasks.set(key, tasks);
  }
  tasks.add(task);
  task.finally(() => {
    tasks!.delete(task);
    if (tasks!.size === 0) chatBackgroundTasks.delete(key);
  });
}

/** Abort the chat's background controller and wait for pending tasks'
 *  HTTP teardown to complete (bounded at 2s). The next call to
 *  `getChatBackgroundSignal` creates a fresh controller. */
export async function abortChatBackground(userId: string, chatId: string): Promise<void> {
  const key = chatBgKey(userId, chatId);
  const ctrl = chatBackgroundControllers.get(key);
  if (ctrl && !ctrl.signal.aborted) {
    ctrl.abort();
  }
  chatBackgroundControllers.delete(key);

  const tasks = chatBackgroundTasks.get(key);
  if (tasks && tasks.size > 0) {
    await Promise.race([
      Promise.allSettled([...tasks]),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ]);
    chatBackgroundTasks.delete(key);
  }
}

/** Abort every background controller for a user (called from
 *  stopUserGenerations / shutdown paths). */
export function abortUserBackgrounds(userId: string): void {
  const prefix = `${userId}:`;
  for (const [key, ctrl] of chatBackgroundControllers) {
    if (key.startsWith(prefix)) {
      if (!ctrl.signal.aborted) ctrl.abort();
      chatBackgroundControllers.delete(key);
    }
  }
  for (const [key] of chatBackgroundTasks) {
    if (key.startsWith(prefix)) chatBackgroundTasks.delete(key);
  }
}

/** Abort every background controller (called from graceful shutdown). */
export function abortAllBackgrounds(): void {
  for (const ctrl of chatBackgroundControllers.values()) {
    if (!ctrl.signal.aborted) ctrl.abort();
  }
  chatBackgroundControllers.clear();
  chatBackgroundTasks.clear();
}
