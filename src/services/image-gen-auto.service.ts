import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { generateSceneBackground, getImageGenSettings } from "./image-gen.service";

interface GenerationEndedPayload {
  chatId?: string;
  messageId?: string;
  error?: string;
}

let listenersRegistered = false;

export async function maybeAutoGenerateOnReply(
  userId: string,
  payload: GenerationEndedPayload,
): Promise<boolean> {
  const chatId = typeof payload.chatId === "string" && payload.chatId
    ? payload.chatId
    : null;
  if (!chatId) return false;
  if (payload.error) return false;

  // Foreground pages already run the existing client-side auto-generate flow.
  // This backend path only exists as a fallback for hidden/closed sessions.
  if (eventBus.isUserVisible(userId)) return false;

  const settings = getImageGenSettings(userId);
  if (!settings.enabled || settings.autoGenerate === false) return false;
  if (!settings.activeImageGenConnectionId) return false;

  const outputTarget = settings.outputTarget || "background";
  const attachToMessageId = outputTarget === "attach_to_message"
    ? (typeof payload.messageId === "string" && payload.messageId ? payload.messageId : null)
    : null;

  if (outputTarget === "attach_to_message" && !attachToMessageId) {
    return false;
  }

  try {
    await generateSceneBackground(
      userId,
      chatId,
      attachToMessageId ? { attachToMessageId } : undefined,
    );
    return true;
  } catch (err) {
    console.warn(`[image-gen-auto] Fallback auto-generate failed for chat ${chatId}:`, err);
    return false;
  }
}

export function initImageGenAutoListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  eventBus.on(EventType.GENERATION_ENDED, (event) => {
    if (!event.userId) return;
    void maybeAutoGenerateOnReply(
      event.userId,
      event.payload as GenerationEndedPayload,
    );
  });

  console.log("[image-gen-auto] EventBus listeners registered");
}
