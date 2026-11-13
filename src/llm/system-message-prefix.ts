import type { LlmMessage } from "./types";

/**
 * Split only the contiguous system-message prefix from an assembled prompt.
 *
 * Provider APIs with a dedicated top-level system field may safely lift this
 * prefix. System messages after the first user/assistant message are
 * intentionally left in place: they may have been positioned at a specific
 * chat-history depth or explicitly placed after history.
 */
export function splitLeadingSystemMessagePrefix(
  messages: readonly LlmMessage[],
): { prefix: LlmMessage[]; remainder: LlmMessage[] } {
  let prefixLength = 0;
  while (
    prefixLength < messages.length &&
    messages[prefixLength].role === "system"
  ) {
    prefixLength++;
  }

  return {
    prefix: messages.slice(0, prefixLength),
    remainder: messages.slice(prefixLength),
  };
}
