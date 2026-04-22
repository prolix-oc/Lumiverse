import * as settingsSvc from "../services/settings.service";
import type { SanitizeOptions } from "./content-sanitizer";

export interface ReasoningDelimiters {
  prefix: string;
  suffix: string;
}

export interface ExtractDelimitedReasoningResult {
  cleaned: string;
  reasoning: string;
}

export function normalizeReasoningDelimiter(value: unknown, fallback: string): string {
  return (typeof value === "string" ? value : fallback).replace(/^\n+|\n+$/g, "");
}

export function resolveReasoningDelimiters(value?: { prefix?: unknown; suffix?: unknown } | null): ReasoningDelimiters {
  return {
    prefix: normalizeReasoningDelimiter(value?.prefix, "<think>\n"),
    suffix: normalizeReasoningDelimiter(value?.suffix, "\n</think>"),
  };
}

export function hasReasoningDelimiters(delimiters: ReasoningDelimiters): boolean {
  return !!(delimiters.prefix && delimiters.suffix);
}

export function closeUnterminatedDelimitedReasoning(content: string, delimiters: ReasoningDelimiters): string {
  if (!content || !hasReasoningDelimiters(delimiters)) return content;
  const lastOpenIdx = content.lastIndexOf(delimiters.prefix);
  if (lastOpenIdx === -1) return content;
  const afterOpen = content.indexOf(delimiters.suffix, lastOpenIdx + delimiters.prefix.length);
  return afterOpen === -1 ? content + delimiters.suffix : content;
}

export function extractDelimitedReasoning(content: string, delimiters: ReasoningDelimiters): ExtractDelimitedReasoningResult {
  if (!content || !hasReasoningDelimiters(delimiters) || !content.includes(delimiters.prefix)) {
    return { cleaned: content, reasoning: "" };
  }

  let cleaned = content;
  let reasoning = "";
  let idx = cleaned.indexOf(delimiters.prefix);
  while (idx !== -1) {
    const endIdx = cleaned.indexOf(delimiters.suffix, idx + delimiters.prefix.length);
    if (endIdx !== -1) {
      reasoning += cleaned.slice(idx + delimiters.prefix.length, endIdx);
      cleaned = cleaned.slice(0, idx) + cleaned.slice(endIdx + delimiters.suffix.length);
    } else {
      reasoning += cleaned.slice(idx + delimiters.prefix.length);
      cleaned = cleaned.slice(0, idx);
      break;
    }
    idx = cleaned.indexOf(delimiters.prefix);
  }

  return { cleaned, reasoning };
}

export class GuidedReasoningStreamParser {
  private readonly enabled: boolean;
  private phase: "detecting" | "reasoning" | "content";
  private detectBuffer = "";
  private suffixBuffer = "";

  constructor(private readonly delimiters: ReasoningDelimiters, enabled: boolean) {
    this.enabled = enabled && hasReasoningDelimiters(delimiters);
    this.phase = this.enabled ? "detecting" : "content";
  }

  push(token: string): { content: string; reasoning: string } {
    if (!token) return { content: "", reasoning: "" };
    if (!this.enabled) return { content: token, reasoning: "" };

    let content = "";
    let reasoning = "";
    const emitContent = (text: string) => { content += text; };
    const emitReasoning = (text: string) => { reasoning += text; };

    const processReasoningChunk = (chunk: string) => {
      this.suffixBuffer += chunk;
      const suffixIdx = this.suffixBuffer.indexOf(this.delimiters.suffix);
      if (suffixIdx !== -1) {
        emitReasoning(this.suffixBuffer.slice(0, suffixIdx));
        const afterSuffix = this.suffixBuffer.slice(suffixIdx + this.delimiters.suffix.length);
        this.phase = "content";
        this.suffixBuffer = "";
        if (afterSuffix) emitContent(afterSuffix);
        return;
      }

      const safe = this.suffixBuffer.length - Math.max(this.delimiters.suffix.length - 1, 0);
      if (safe > 0) {
        emitReasoning(this.suffixBuffer.slice(0, safe));
        this.suffixBuffer = this.suffixBuffer.slice(safe);
      }
    };

    const processContentChunk = (chunk: string) => {
      if (this.phase === "content") {
        this.detectBuffer += chunk;
        const prefixIdx = this.detectBuffer.indexOf(this.delimiters.prefix);
        if (prefixIdx !== -1) {
          if (prefixIdx > 0) emitContent(this.detectBuffer.slice(0, prefixIdx));
          this.phase = "reasoning";
          const afterPrefix = this.detectBuffer.slice(prefixIdx + this.delimiters.prefix.length);
          this.detectBuffer = "";
          if (afterPrefix) processReasoningChunk(afterPrefix);
          return;
        }

        let partialLen = Math.min(this.detectBuffer.length, this.delimiters.prefix.length - 1);
        while (partialLen > 0) {
          if (this.delimiters.prefix.startsWith(this.detectBuffer.slice(-partialLen))) break;
          partialLen--;
        }
        const safeLen = this.detectBuffer.length - partialLen;
        if (safeLen > 0) {
          emitContent(this.detectBuffer.slice(0, safeLen));
          this.detectBuffer = this.detectBuffer.slice(safeLen);
        }
        return;
      }

      if (this.phase === "detecting") {
        this.detectBuffer += chunk;
        const trimmed = this.detectBuffer.trimStart();
        if (trimmed.length >= this.delimiters.prefix.length && trimmed.startsWith(this.delimiters.prefix)) {
          this.phase = "reasoning";
          const afterPrefix = trimmed.slice(this.delimiters.prefix.length);
          this.detectBuffer = "";
          if (afterPrefix) processReasoningChunk(afterPrefix);
        } else if (!this.delimiters.prefix.startsWith(trimmed)) {
          this.phase = "content";
          const buffer = this.detectBuffer;
          this.detectBuffer = "";
          processContentChunk(buffer);
        }
        return;
      }

      processReasoningChunk(chunk);
    };

    processContentChunk(token);
    return { content, reasoning };
  }

  flush(): { content: string; reasoning: string } {
    if (!this.enabled) return { content: "", reasoning: "" };

    let content = "";
    let reasoning = "";
    if (this.detectBuffer) {
      if (this.phase === "reasoning") reasoning += this.detectBuffer;
      else content += this.detectBuffer;
      this.detectBuffer = "";
    }
    if (this.phase === "reasoning" && this.suffixBuffer) {
      reasoning += this.suffixBuffer;
      this.suffixBuffer = "";
    }
    this.phase = "content";
    return { content, reasoning };
  }
}

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
  const delimiters = resolveReasoningDelimiters(value);
  if (!hasReasoningDelimiters(delimiters)) return undefined;
  return { reasoningPrefix: delimiters.prefix, reasoningSuffix: delimiters.suffix };
}
