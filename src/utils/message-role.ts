import type { Message } from "../types/message";

/** Stored system messages share is_user=false with assistant messages. */
export function getMessageRole(message: Pick<Message, "is_user" | "extra">): "user" | "assistant" | "system" {
  return message.is_user ? "user" : message.extra?.spindle_role === "system" ? "system" : "assistant";
}
