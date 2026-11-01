import type { DisplayMessageSource } from "../types/message";
import type { MessagePresetContext } from "../types/preset-context";
import { messageContentProcessorChain } from "../spindle/message-content-processor";
import { resolveDisplayMessageBody, type DisplayRenderContext } from "./chat-macro-render.service";

/** The body stage shared by native display and server-side action verification. */
export async function preprocessDisplayMessage(input: {
  userId: string;
  chatId: string;
  content: string;
  message?: DisplayMessageSource;
  messageId?: string;
  messageIndex?: number;
  role?: string;
  swipeIndex?: number;
  presetContext?: MessagePresetContext;
  signal?: AbortSignal;
  context?: DisplayRenderContext;
}) {
  const hasContentProcessor = messageContentProcessorChain.hasForUser(input.userId);
  const processed = hasContentProcessor
    ? await messageContentProcessorChain.run({
        chatId: input.chatId,
        content: input.content,
        isUser: input.role === "user",
        origin: "render",
        userId: input.userId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        extra: {
          ...(typeof input.messageIndex === "number" ? { messageIndex: input.messageIndex } : {}),
          ...(input.role ? { role: input.role, is_user: input.role === "user" } : {}),
        },
      }, input.userId, input.signal)
    : { content: input.content };
  const content = await resolveDisplayMessageBody(
    input.userId, input.chatId, processed.content ?? input.content,
    input.message, input.swipeIndex, input.signal, input.presetContext,
    // Processors can change chat state while running; keep their existing
    // per-item reads rather than sharing a snapshot across those mutations.
    hasContentProcessor ? undefined : input.context,
  );
  return { content, incrementalRawAppendSafe: !hasContentProcessor };
}
