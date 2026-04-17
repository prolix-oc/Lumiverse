import * as settingsSvc from "../services/settings.service";
import type { SanitizeOptions } from "./content-sanitizer";

/**
 * Resolve the user's configured reasoning prefix/suffix so callers can strip
 * custom CoT delimiters from content before it enters chat chunks, retrieval
 * queries, or Memory Cortex. Returns undefined when the user hasn't configured
 * any reasoning settings — the default `<think>` tags are already covered by
 * `sanitizeForVectorization`.
 */
export function getReasoningStripOptions(userId: string): SanitizeOptions | undefined {
  const setting = settingsSvc.getSetting(userId, "reasoningSettings");
  const value = setting?.value as { prefix?: string; suffix?: string } | null | undefined;
  if (!value) return undefined;
  const prefix = typeof value.prefix === "string" ? value.prefix : undefined;
  const suffix = typeof value.suffix === "string" ? value.suffix : undefined;
  if (!prefix || !suffix) return undefined;
  return { reasoningPrefix: prefix, reasoningSuffix: suffix };
}
