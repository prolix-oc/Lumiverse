export interface ReasoningDelimitersV1 {
  readonly prefix: string;
  readonly suffix: string;
}

export interface ExtractDelimitedReasoningV1 {
  readonly cleaned: string;
  readonly reasoning: string;
}

const TRAILING_NEWLINE_RUN_RE = /(?:\n[ \t\f\v]*)+$/;
const LEADING_NEWLINE_RUN_RE = /^(?:[ \t\f\v]*\n)+/;

function countNewlines(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

function hasVisibleText(value: string): boolean {
  return /\S/.test(value);
}

function getTrailingNewlineRunCount(value: string): number {
  const match = value.match(TRAILING_NEWLINE_RUN_RE);
  return match ? countNewlines(match[0]) : 0;
}

function joinContentAroundExtractedReasoning(before: string, after: string): string {
  const beforeVisible = hasVisibleText(before);
  const afterVisible = hasVisibleText(after);
  if (!beforeVisible && !afterVisible) return "";
  if (!beforeVisible) return after.replace(LEADING_NEWLINE_RUN_RE, "");
  if (!afterVisible) return before.replace(TRAILING_NEWLINE_RUN_RE, "");
  const beforeNewlines = getTrailingNewlineRunCount(before);
  const afterNewlines = (after.match(LEADING_NEWLINE_RUN_RE)?.[0].match(/\n/g)?.length ?? 0);
  const keepNewlines = Math.min(2, Math.max(beforeNewlines, afterNewlines));
  const normalizedBefore = before.replace(TRAILING_NEWLINE_RUN_RE, "");
  const normalizedAfter = after.replace(LEADING_NEWLINE_RUN_RE, "");
  return normalizedBefore + "\n".repeat(keepNewlines) + normalizedAfter;
}

export function normalizeReasoningDelimiterV1(value: unknown, fallback: string): string {
  return (typeof value === "string" ? value : fallback).replace(/^\n+|\n+$/g, "");
}

export function resolveReasoningDelimitersV1(
  value?: { prefix?: unknown; suffix?: unknown } | null,
): ReasoningDelimitersV1 {
  return {
    prefix: normalizeReasoningDelimiterV1(value?.prefix, "<think>\n"),
    suffix: normalizeReasoningDelimiterV1(value?.suffix, "\n</think>"),
  };
}

export function extractDelimitedReasoningV1(
  content: string,
  delimiters: ReasoningDelimitersV1,
): ExtractDelimitedReasoningV1 {
  if (!content || !delimiters.prefix || !delimiters.suffix || !content.includes(delimiters.prefix)) {
    return { cleaned: content, reasoning: "" };
  }
  let cleaned = content;
  let reasoning = "";
  let index = cleaned.indexOf(delimiters.prefix);
  while (index !== -1) {
    const end = cleaned.indexOf(delimiters.suffix, index + delimiters.prefix.length);
    if (end !== -1) {
      reasoning += cleaned.slice(index + delimiters.prefix.length, end);
      cleaned = joinContentAroundExtractedReasoning(
        cleaned.slice(0, index),
        cleaned.slice(end + delimiters.suffix.length),
      );
    } else {
      reasoning += cleaned.slice(index + delimiters.prefix.length);
      cleaned = joinContentAroundExtractedReasoning(cleaned.slice(0, index), "");
      break;
    }
    index = cleaned.indexOf(delimiters.prefix);
  }
  return { cleaned, reasoning };
}
