import type { LlmMessage } from "./types";

// String keys survive assembly-worker structured cloning and message spreads.
// Provider serializers select public fields, so this marker stays internal.
export const CHAT_HISTORY_KEY = "__chatHistorySource";

export function isChatHistoryMessage(message: LlmMessage): boolean {
  return (message as LlmMessage & { [CHAT_HISTORY_KEY]?: boolean })[CHAT_HISTORY_KEY] === true;
}
