import type { Message } from "./message";
import { getMessageRole } from "../utils/message-role";

export const MAX_PRESET_HISTORY = 100;
/** Reserved read-only dependency, carried alongside variable reads through result caches. */
export const presetHistoryDependency = (chatId: string) => `context:presetHistory:${chatId}`;

export interface PresetHistoryEntry { id?: string; name?: string }
export interface PresetHistoryTarget { messageId: string; entry: PresetHistoryEntry | null }
/** Request-local, serializable memo. Undefined candidates means history was deliberately deferred. */
export interface PresetHistorySnapshot {
  candidates?: PresetHistoryEntry[];
  names?: string[];
}

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** Provenance only: never applies a preset or replays its variables/regex scripts. */
export function readPresetHistoryEntry(message: Pick<Message, "is_user" | "content" | "swipe_id" | "extra">): PresetHistoryEntry | null {
  const { extra, swipe_id: index } = message;
  if (getMessageRole(message) !== "assistant" || !message.content.trim()
    || extra?.hidden || extra?._loom_inject || extra?.greeting
    || !Number.isSafeInteger(index) || index < 0) return null;
  const selected = (key: string) => Array.isArray(extra?.[`${key}BySwipe`])
    ? extra[`${key}BySwipe`][index] : extra?.[key];
  const metrics = selected("generationMetrics");
  const contexts = extra?.spindle_metadata?.preset_contexts;
  const context = Array.isArray(contexts) ? contexts[index] : undefined;
  const activation = selected("promptActivation");
  const contextId = record(context) ? text(context.preset_id) : undefined;
  let id = contextId;
  if (!id && record(activation) && Object.hasOwn(activation, "preset_id")) {
    if (activation.preset_id === null) return null; // Explicit no-preset attribution wins over old metrics.
    id = text(activation.preset_id);
    if (!id) return null;
  }
  if (!id) id = record(metrics) ? text(metrics.presetId) : undefined;
  const metricId = record(metrics) ? text(metrics.presetId) : undefined;
  const name = record(metrics) && (id ? metricId === id : !metricId)
    ? text(metrics.presetName) : undefined;
  return id || name ? { ...(id ? { id } : {}), ...(name ? { name } : {}) } : null;
}

export function capturePresetHistory(
  messages: ReadonlyArray<Pick<Message, "id" | "is_user" | "content" | "swipe_id" | "extra">>,
  target?: PresetHistoryTarget,
): PresetHistorySnapshot {
  const candidates: PresetHistoryEntry[] = [];
  for (let i = messages.length - 1; i >= 0 && candidates.length < MAX_PRESET_HISTORY; i--) {
    const message = messages[i];
    const entry = target?.messageId === message.id ? target.entry : readPresetHistoryEntry(message);
    if (entry) candidates.push(entry);
  }
  return { candidates };
}
