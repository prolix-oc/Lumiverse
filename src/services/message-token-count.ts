import * as connectionsSvc from "./connections.service";
import * as settingsSvc from "./settings.service";
import * as tokenizerSvc from "./tokenizer.service";

/** Setting key (shared with the frontend store) that gates message token counts. */
export const SHOW_MESSAGE_TOKEN_COUNT_KEY = "showMessageTokenCount";

/**
 * Collaborators for {@link computeMessageTokenCount}. Injectable so the glue
 * logic (gating + model resolution + graceful failure) can be unit-tested
 * without a real tokenizer, settings, or connection DB. Routes call the
 * function with the defaults.
 */
export interface MessageTokenCountDeps {
  /** Whether the user has message token counts enabled. */
  isEnabled: (userId: string) => boolean;
  /** Resolve the model id whose tokenizer should count the text, or null/undefined if none. */
  resolveModel: (userId: string, connectionId?: string) => string | null | undefined;
  /** Count tokens for the given model, returning null when no tokenizer matches. */
  countForModel: (model: string, text: string) => Promise<number | null>;
}

const defaultDeps: MessageTokenCountDeps = {
  // Mirror the frontend default (true): only opt out when explicitly disabled.
  isEnabled: (userId) =>
    settingsSvc.getSetting(userId, SHOW_MESSAGE_TOKEN_COUNT_KEY)?.value !== false,
  resolveModel: (userId, connectionId) =>
    (connectionId
      ? connectionsSvc.getConnection(userId, connectionId)
      : connectionsSvc.getDefaultConnection(userId))?.model,
  countForModel: tokenizerSvc.countForModel,
};

/**
 * Best-effort token count for a message's raw content, mirroring how assistant
 * output is tokenized after generation (see generate.service). Lets user-sent
 * messages carry a `tokenCount` in `extra` so the UI can show it alongside
 * assistant counts.
 *
 * Gated by the `showMessageTokenCount` user setting — when the user has counts
 * turned off there's nothing to display, so we skip the work entirely rather
 * than store metadata that would never be shown.
 *
 * The tokenizer is resolved from the caller's connection model (the explicit
 * `connectionId` when given, otherwise their default connection). This is a
 * display approximation: a chat may generate with a different connection, but
 * no per-message connection is recorded at send time.
 *
 * Always non-fatal — disabled counts, empty content, no resolvable
 * model/tokenizer, or an encode failure all yield `undefined`. Token counts are
 * optional metadata and must never block message persistence.
 */
export async function computeMessageTokenCount(
  userId: string,
  content: string,
  connectionId?: string,
  deps: MessageTokenCountDeps = defaultDeps,
): Promise<number | undefined> {
  if (!content) return undefined;
  try {
    if (!deps.isEnabled(userId)) return undefined;
    const model = deps.resolveModel(userId, connectionId);
    if (!model) return undefined;
    return (await deps.countForModel(model, content)) ?? undefined;
  } catch {
    return undefined;
  }
}
