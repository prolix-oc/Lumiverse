import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

export type SpindlePreGenerationPhase =
  | "message_content_processor"
  | "context_handler"
  | "interceptor";

export type SpindlePreGenerationStatus =
  | "started"
  | "completed"
  | "error"
  | "aborted";

export function emitSpindlePreGenerationActivity(input: {
  chatId?: string | null;
  userId?: string | null;
  phase: SpindlePreGenerationPhase;
  status: SpindlePreGenerationStatus;
  extensionId: string;
  extensionName?: string | null;
  error?: string;
}): void {
  if (!input.chatId || !input.userId) return;

  eventBus.emit(
    EventType.SPINDLE_PRE_GENERATION_ACTIVITY,
    {
      chatId: input.chatId,
      phase: input.phase,
      status: input.status,
      extensionId: input.extensionId,
      extensionName:
        input.extensionName?.trim() || input.extensionId,
      ...(input.error ? { error: input.error } : {}),
    },
    input.userId,
  );
}
