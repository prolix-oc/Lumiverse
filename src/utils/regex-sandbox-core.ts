import { getRegexSearchEnd } from "./regex-search-window";
import {
  REGEX_LIMITS_V1,
  RegexLimitError,
  assertRegexTextBytes,
  throwIfRegexAborted,
  utf8ByteLength,
} from "./regex-limits";

export interface RegexExecutionLimits {
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxExpansionBytes?: number;
  maxOperationBytes?: number;
  maxMatches?: number;
  deadlineAt?: number;
}

export interface RegexReplaceRequest {
  id: string;
  op: "replace";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
  limits?: RegexExecutionLimits;
}

export interface RegexTestRequest {
  id: string;
  op: "test";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
  limits?: RegexExecutionLimits;
}

export interface RegexCollectRequest {
  id: string;
  op: "collect";
  pattern: string;
  flags: string;
  input: string;
  limits?: RegexExecutionLimits;
}

export interface RegexCaptureReplacementsRequest {
  id: string;
  op: "capture-replacements";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
  replacementMode?: "raw" | "native";
  limits?: RegexExecutionLimits;
}

export type RegexRequest =
  | RegexReplaceRequest
  | RegexTestRequest
  | RegexCollectRequest
  | RegexCaptureReplacementsRequest;

export interface CollectedMatch {
  fullMatch: string;
  index: number;
  groups: (string | undefined)[];
  namedGroups?: Record<string, string | undefined>;
}

export interface CaptureReplacement {
  index: number;
  matchLength: number;
  replacement: string;
}

/**
 * Apply the capture-reference syntax used by raw-mode regex scripts.
 *
 * Keep this separate from native String#replace semantics: raw mode has long
 * exposed this exact contract (notably, capture references are limited to two
 * digits and an out-of-range reference is left untouched).
 */
export function substituteRegexCaptures(
  template: string,
  fullMatch: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  namedGroups?: Record<string, string | undefined>,
  maxBytes = REGEX_LIMITS_V1.maxOperationBytes,
): string {
  return substituteRegexCapturesFromArrayLike(
    template,
    fullMatch,
    groups,
    0,
    offset,
    input,
    namedGroups,
    false,
    maxBytes,
  );
}

function substitutionToken(
  token: string,
  fullMatch: string,
  groups: ArrayLike<string | undefined>,
  groupOffset: number,
  offset: number,
  input: string,
  namedGroups: Record<string, string | undefined> | undefined,
  native: boolean,
): { kind: "value"; value: string } | { kind: "span"; start: number; end: number } | null {
  if (token === "$$") return { kind: "value", value: "$" };
  if (token === "$&") return { kind: "value", value: fullMatch };
  if (token === "$`") return { kind: "span", start: 0, end: offset };
  if (token === "$'") return { kind: "span", start: offset + fullMatch.length, end: input.length };

  if (token.startsWith("$<") && token.endsWith(">")) {
    const name = token.slice(2, -1);
    if (namedGroups && Object.prototype.hasOwnProperty.call(namedGroups, name)) {
      return { kind: "value", value: namedGroups[name] ?? "" };
    }
    if (native && namedGroups) return { kind: "value", value: "" };
    return native ? null : { kind: "value", value: token };
  }

  if (token.length >= 2 && token[0] === "$" && /\d/.test(token[1]!)) {
    const first = Number(token[1]);
    if (native) {
      const second = token.length > 2 && /\d/.test(token[2]!) ? Number(token[2]) : null;
      if (first === 0) {
        if (second !== null && second > 0 && second <= groups.length - groupOffset) {
          return { kind: "value", value: groups[groupOffset + second - 1] ?? "" };
        }
        return null;
      }
      const twoDigit = second === null ? first : first * 10 + second;
      if (second !== null && twoDigit > 0 && twoDigit <= groups.length - groupOffset) {
        return { kind: "value", value: groups[groupOffset + twoDigit - 1] ?? "" };
      }
      if (first <= groups.length - groupOffset) {
        const value = groups[groupOffset + first - 1] ?? "";
        return { kind: "value", value: second === null ? value : value + token[2] };
      }
      return null;
    }
    const index = Number(token.slice(1));
    if (index >= 1 && index <= groups.length - groupOffset) {
      return { kind: "value", value: groups[groupOffset + index - 1] ?? "" };
    }
    return { kind: "value", value: token };
  }

  return null;
}

function findSubstitutionToken(template: string, start: number): { token: string; end: number } | null {
  if (template[start] !== "$" || start + 1 >= template.length) return null;
  const next = template[start + 1]!;
  if (next === "$" || next === "&" || next === "`" || next === "'") {
    return { token: template.slice(start, start + 2), end: start + 2 };
  }
  if (/\d/.test(next)) {
    const end = start + 2 < template.length && /\d/.test(template[start + 2]!)
      ? start + 3
      : start + 2;
    return { token: template.slice(start, end), end };
  }
  if (next === "<") {
    const close = template.indexOf(">", start + 2);
    if (close >= 0) return { token: template.slice(start, close + 1), end: close + 1 };
  }
  return null;
}

function substituteRegexCapturesFromArrayLike(
  template: string,
  fullMatch: string,
  groups: ArrayLike<string | undefined>,
  groupOffset: number,
  offset: number,
  input: string,
  namedGroups?: Record<string, string | undefined>,
  native = false,
  maxBytes?: number,
): string {
  let totalBytes = 0;
  const parts: Array<string | { start: number; end: number }> = [];
  const addValue = (value: string | { start: number; end: number }): void => {
    const bytes = typeof value === "string"
      ? utf8ByteLength(value)
      : utf8ByteLengthRange(input, value.start, value.end);
    totalBytes += bytes;
    if (maxBytes !== undefined && totalBytes > maxBytes) {
      throw new RegexLimitError(
        "operation_limit_exceeded",
        `Regex replacement exceeds ${maxBytes} bytes`,
      );
    }
    parts.push(value);
  };

  let cursor = 0;
  let index = 0;
  while (index < template.length) {
    const tokenInfo = template[index] === "$" ? findSubstitutionToken(template, index) : null;
    if (!tokenInfo) {
      index += 1;
      continue;
    }
    if (index > cursor) addValue(template.slice(cursor, index));
    const resolved = substitutionToken(
      tokenInfo.token,
      fullMatch,
      groups,
      groupOffset,
      offset,
      input,
      namedGroups,
      native,
    );
    if (resolved?.kind === "span") {
      addValue(resolved);
    } else {
      addValue(resolved?.value ?? tokenInfo.token);
    }
    index = tokenInfo.end;
    cursor = index;
  }
  if (cursor < template.length) addValue(template.slice(cursor));
  return parts.map((part) => typeof part === "string" ? part : input.slice(part.start, part.end)).join("");
}

interface EffectiveLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxExpansionBytes: number;
  maxOperationBytes: number;
  maxMatches: number;
  deadlineAt?: number;
}
function boundedLimit(
  value: unknown,
  fallback: number,
  ceiling: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, ceiling);
}

function effectiveLimits(limits?: RegexExecutionLimits): EffectiveLimits {
  const deadlineAt = limits?.deadlineAt;
  return {
    maxInputBytes: boundedLimit(limits?.maxInputBytes, REGEX_LIMITS_V1.maxInputBytes, REGEX_LIMITS_V1.maxInputBytes),
    maxOutputBytes: boundedLimit(limits?.maxOutputBytes, REGEX_LIMITS_V1.maxOutputBytes, REGEX_LIMITS_V1.maxOutputBytes),
    maxExpansionBytes: boundedLimit(limits?.maxExpansionBytes, REGEX_LIMITS_V1.maxExpansionBytes, REGEX_LIMITS_V1.maxExpansionBytes),
    maxOperationBytes: boundedLimit(limits?.maxOperationBytes, REGEX_LIMITS_V1.maxOperationBytes, REGEX_LIMITS_V1.maxOperationBytes),
    maxMatches: boundedLimit(limits?.maxMatches, REGEX_LIMITS_V1.maxMatchCount, REGEX_LIMITS_V1.maxMatchCount),
    deadlineAt: typeof deadlineAt === "number" && Number.isFinite(deadlineAt) ? deadlineAt : undefined,
  };
}
function utf8ByteLengthRange(value: string, start: number, end: number): number {
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function nextRegexIndex(input: string, index: number, unicode: boolean): number {
  if (!unicode || index >= input.length) return index + 1;
  const first = input.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = input.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return index + 2;
  }
  return index + 1;
}

function checkDeadline(limits: EffectiveLimits): void {
  throwIfRegexAborted(undefined, limits.deadlineAt);
}

const MAX_CAPTURE_GROUPS = 1_024;

function captureByteLength(match: RegExpExecArray): number {
  let bytes = utf8ByteLength(match[0]);
  for (let index = 1; index < match.length; index++) {
    const capture = match[index];
    if (capture !== undefined) bytes += utf8ByteLength(capture);
  }
  if (match.groups) {
    for (const [name, capture] of Object.entries(match.groups)) {
      bytes += utf8ByteLength(name);
      if (capture !== undefined) bytes += utf8ByteLength(capture);
    }
  }
  return bytes;
}

function assertCaptureWithinLimits(
  match: RegExpExecArray,
  matchCount: number,
  captureBytes: number,
  limits: EffectiveLimits,
): number {
  if (match.length - 1 > MAX_CAPTURE_GROUPS) {
    throw new RegexLimitError(
      "operation_limit_exceeded",
      `Regex capture group count exceeds ${MAX_CAPTURE_GROUPS}`,
    );
  }
  const matchBytes = captureByteLength(match);
  if (matchBytes > limits.maxOperationBytes) {
    throw new RegexLimitError(
      "operation_limit_exceeded",
      `Regex capture bytes exceed ${limits.maxOperationBytes} per match`,
    );
  }
  const nextBytes = captureBytes + matchBytes;
  if (nextBytes > limits.maxOutputBytes) {
    throw new RegexLimitError(
      "output_limit_exceeded",
      `Regex capture bytes exceed ${limits.maxOutputBytes} per request`,
    );
  }
  if (matchCount >= limits.maxMatches) {
    throw new RegexLimitError(
      "match_limit_exceeded",
      `Regex matched more than ${limits.maxMatches} times`,
    );
  }
  return nextBytes;
}

function collectMatches(input: string, re: RegExp, limits: EffectiveLimits): CollectedMatch[] {
  const matches: CollectedMatch[] = [];
  let captureBytes = 0;
  const append = (match: RegExpExecArray): void => {
    checkDeadline(limits);
    captureBytes = assertCaptureWithinLimits(match, matches.length, captureBytes, limits);
    matches.push({
      fullMatch: match[0],
      index: match.index,
      groups: Array.from(match).slice(1),
      namedGroups: match.groups,
    });
  };

  if (re.global || re.sticky) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      append(match);
      if (match[0].length === 0) re.lastIndex = nextRegexIndex(input, re.lastIndex, re.unicode);
    }
  } else {
    const match = re.exec(input);
    if (match) append(match);
  }
  return matches;
}

/**
 * Resolve capture references before crossing the worker boundary. Returning
 * only the replacement and match span avoids structured-cloning every capture
 * (often hundreds of strings per match) into the main process.
 */
function collectCaptureReplacements(
  input: string,
  re: RegExp,
  template: string,
  limits: EffectiveLimits,
): CaptureReplacement[] {
  const replacements: CaptureReplacement[] = [];
  let generatedBytes = 0;
  let captureBytes = 0;

  const append = (match: RegExpExecArray): void => {
    captureBytes = assertCaptureWithinLimits(match, replacements.length, captureBytes, limits);
    checkDeadline(limits);
    const replacement = substituteRegexCapturesFromArrayLike(
      template,
      match[0],
      match,
      1,
      match.index,
      input,
      match.groups,
      false,
      limits.maxOperationBytes,
    );
    const replacementBytes = utf8ByteLength(replacement);
    if (replacementBytes > limits.maxOperationBytes) {
      throw new RegexLimitError(
        "operation_limit_exceeded",
        `Regex replacement exceeds ${limits.maxOperationBytes} bytes`,
      );
    }
    generatedBytes += replacementBytes;
    if (generatedBytes > limits.maxExpansionBytes) {
      throw new RegexLimitError(
        "expansion_limit_exceeded",
        `Regex replacements exceeded ${limits.maxExpansionBytes} bytes`,
      );
    }
    replacements.push({
      index: match.index,
      matchLength: match[0].length,
      replacement,
    });
  };

  if (re.global || re.sticky) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      append(match);
      if (match[0].length === 0) re.lastIndex = nextRegexIndex(input, re.lastIndex, re.unicode);
    }
  } else {
    const match = re.exec(input);
    if (match) append(match);
  }
  return replacements;
}
function collectNativeCaptureReplacements(
  input: string,
  pattern: string,
  flags: string,
  template: string,
  limits: EffectiveLimits,
): CaptureReplacement[] {
  const re = new RegExp(pattern, flags);
  const replacements: CaptureReplacement[] = [];
  let captureBytes = 0;
  let generatedBytes = 0;
  const append = (match: RegExpExecArray): void => {
    captureBytes = assertCaptureWithinLimits(match, replacements.length, captureBytes, limits);
    checkDeadline(limits);
    const replacement = substituteRegexCapturesFromArrayLike(
      template,
      match[0],
      match,
      1,
      match.index,
      input,
      match.groups,
      true,
      limits.maxOperationBytes,
    );
    const replacementBytes = utf8ByteLength(replacement);
    generatedBytes += replacementBytes;
    if (generatedBytes > limits.maxExpansionBytes) {
      throw new RegexLimitError(
        "expansion_limit_exceeded",
        `Regex replacements exceeded ${limits.maxExpansionBytes} bytes`,
      );
    }
    replacements.push({
      index: match.index,
      matchLength: match[0].length,
      replacement,
    });
  };

  if (re.global || re.sticky) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      append(match);
      if (match[0].length === 0) re.lastIndex = nextRegexIndex(input, re.lastIndex, re.unicode);
    }
  } else {
    const match = re.exec(input);
    if (match) append(match);
  }
  return replacements;
}


function buildReplacementResult(
  input: string,
  replacements: readonly CaptureReplacement[],
  tail: string,
  limits: EffectiveLimits,
): string {
  let outputBytes = utf8ByteLength(tail);
  let generatedBytes = 0;
  let lastIndex = 0;

  // Validate every span and compute the complete output size before retaining
  // any slices or constructing the final output.
  for (const match of replacements) {
    if (
      !Number.isSafeInteger(match.index)
      || !Number.isSafeInteger(match.matchLength)
      || match.index < lastIndex
      || match.index < 0
      || match.matchLength < 0
      || match.index + match.matchLength > input.length
    ) {
      throw new RegexLimitError("worker_malformed", "Regex replacement returned malformed match spans");
    }
    const replacementBytes = utf8ByteLength(match.replacement);
    if (replacementBytes > limits.maxOperationBytes) {
      throw new RegexLimitError(
        "operation_limit_exceeded",
        `Regex replacement exceeds ${limits.maxOperationBytes} bytes`,
      );
    }
    generatedBytes += replacementBytes;
    if (generatedBytes > limits.maxExpansionBytes) {
      throw new RegexLimitError(
        "expansion_limit_exceeded",
        `Regex replacements exceeded ${limits.maxExpansionBytes} bytes`,
      );
    }
    outputBytes += utf8ByteLengthRange(input, lastIndex, match.index);
    outputBytes += replacementBytes;
    if (outputBytes > limits.maxOutputBytes) {
      throw new RegexLimitError(
        "output_limit_exceeded",
        `Regex output exceeded ${limits.maxOutputBytes} bytes`,
      );
    }
    lastIndex = match.index + match.matchLength;
  }

  outputBytes += utf8ByteLengthRange(input, lastIndex, input.length);
  if (outputBytes > limits.maxOutputBytes) {
    throw new RegexLimitError(
      "output_limit_exceeded",
      `Regex output exceeded ${limits.maxOutputBytes} bytes`,
    );
  }

  const chunks: string[] = [];
  lastIndex = 0;
  for (const match of replacements) {
    chunks.push(input.slice(lastIndex, match.index), match.replacement);
    lastIndex = match.index + match.matchLength;
  }
  chunks.push(input.slice(lastIndex), tail);
  return chunks.join("");
}

function prepareRequest(data: RegexRequest): {
  input: string;
  tail: string;
  limits: EffectiveLimits;
  replacement: string;
} {
  if (
    !data
    || typeof data.pattern !== "string"
    || typeof data.flags !== "string"
    || typeof data.input !== "string"
  ) {
    throw new RegexLimitError("invalid_input", "Regex request requires string pattern, flags, and input");
  }
  const limits = effectiveLimits(data.limits);
  checkDeadline(limits);
  if ("replacement" in data && typeof data.replacement !== "string") {
    throw new RegexLimitError("invalid_input", "Regex replacement must be a string");
  }
  if (
    data.op !== "replace"
    && data.op !== "test"
    && data.op !== "collect"
    && data.op !== "capture-replacements"
  ) {
    throw new RegexLimitError("invalid_input", "Unknown regex operation");
  }
  assertRegexTextBytes(data.input, limits.maxInputBytes, "invalid_input", "Regex input");
  assertRegexTextBytes(data.pattern, REGEX_LIMITS_V1.maxPatternBytes, "pattern_too_large", "Regex pattern");
  const replacement = "replacement" in data ? data.replacement : "";
  assertRegexTextBytes(replacement, REGEX_LIMITS_V1.maxReplacementBytes, "replacement_too_large", "Regex replacement");
  const searchEnd = getRegexSearchEnd(data.input, data.pattern, data.flags, replacement);
  const input = searchEnd === data.input.length ? data.input : data.input.slice(0, searchEnd);
  const tail = searchEnd === data.input.length ? "" : data.input.slice(searchEnd);
  return { input, tail, limits, replacement };
}

export function runRegexRequest(data: RegexRequest): unknown {
  const prepared = prepareRequest(data);
  const re = new RegExp(data.pattern, data.flags);

  if (data.op === "collect") {
    return collectMatches(prepared.input, re, prepared.limits);
  }

  const useNativeReplacement =
    data.op === "replace"
    || data.op === "test"
    || (data.op === "capture-replacements" && data.replacementMode === "native");
  const replacements = useNativeReplacement
    ? collectNativeCaptureReplacements(
      prepared.input,
      data.pattern,
      data.flags,
      prepared.replacement,
      prepared.limits,
    )
    : collectCaptureReplacements(
      prepared.input,
      re,
      prepared.replacement,
      prepared.limits,
    );
  const result = buildReplacementResult(
    prepared.input,
    replacements,
    prepared.tail,
    prepared.limits,
  );

  if (data.op === "replace") return result;
  if (data.op === "test") return { result, matches: replacements.length };
  if (data.op === "capture-replacements") return replacements;
  throw new RegexLimitError("invalid_input", "Unknown regex operation");
}
