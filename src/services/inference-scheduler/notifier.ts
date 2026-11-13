import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import {
  getInferenceSchedulerStatus,
  setInferenceSchedulerChangeListener,
} from "./scheduler";

/**
 * Coalesce queue transitions into one WebSocket status event per user.
 *
 * Imported only by the HTTP host (see app.ts). Worker threads and the
 * vectorization subprocess must not import this module: they have no queues
 * and would only load the WebSocket server.
 */
const DEBOUNCE_MS = 500;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

setInferenceSchedulerChangeListener((userIds) => {
  for (const userId of userIds) {
    if (pending.has(userId)) continue;
    const timer = setTimeout(() => {
      pending.delete(userId);
      try {
        eventBus.emit(
          EventType.INFERENCE_SCHEDULER_STATE,
          {
            status: getInferenceSchedulerStatus(userId),
            at: Date.now(),
          },
          userId,
        );
      } catch (err) {
        // Diagnostics must never break request admission.
        console.warn("[inference-scheduler] status broadcast failed:", err);
      }
    }, DEBOUNCE_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    pending.set(userId, timer);
  }
});

export function stopInferenceSchedulerNotifierForTests(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}

export const __test__ = {
  debounceMs: DEBOUNCE_MS,
  pendingUserCount(): number {
    return pending.size;
  },
};
