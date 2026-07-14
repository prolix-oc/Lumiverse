export interface RegexReplaceRequest {
  id: string;
  op: "replace";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
}

export interface RegexTestRequest {
  id: string;
  op: "test";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
}

export interface RegexCollectRequest {
  id: string;
  op: "collect";
  pattern: string;
  flags: string;
  input: string;
}

export interface RegexCaptureReplacementsRequest {
  id: string;
  op: "capture-replacements";
  pattern: string;
  flags: string;
  input: string;
  replacement: string;
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
  namedGroups?: Record<string, string>;
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
  namedGroups?: Record<string, string>,
): string {
  return substituteRegexCapturesFromArrayLike(
    template,
    fullMatch,
    groups,
    0,
    offset,
    input,
    namedGroups,
  );
}

function substituteRegexCapturesFromArrayLike(
  template: string,
  fullMatch: string,
  groups: ArrayLike<string | undefined>,
  groupOffset: number,
  offset: number,
  input: string,
  namedGroups?: Record<string, string>,
): string {
  const groupCount = groups.length - groupOffset;
  return template.replace(
    /\$(?:(\$)|(&)|(`)|(')|(\d{1,2})|<([^>]*)>)/g,
    (token, dollar, amp, backtick, quote, digits, name) => {
      if (dollar !== undefined) return "$";
      if (amp !== undefined) return fullMatch;
      if (backtick !== undefined) return input.slice(0, offset);
      if (quote !== undefined) return input.slice(offset + fullMatch.length);
      if (digits !== undefined) {
        const idx = parseInt(digits, 10);
        if (idx >= 1 && idx <= groupCount) return groups[idx - 1 + groupOffset] ?? "";
        return token;
      }
      if (name !== undefined && namedGroups) return namedGroups[name] ?? token;
      return token;
    },
  );
}

function collectMatches(input: string, re: RegExp): CollectedMatch[] {
  const matches: CollectedMatch[] = [];
  if (re.global || re.sticky) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      matches.push({
        fullMatch: match[0],
        index: match.index,
        groups: Array.from(match).slice(1),
        namedGroups: match.groups,
      });
      if (match[0].length === 0) re.lastIndex++;
    }
  } else {
    const match = re.exec(input);
    if (match) {
      matches.push({
        fullMatch: match[0],
        index: match.index,
        groups: Array.from(match).slice(1),
        namedGroups: match.groups,
      });
    }
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
): CaptureReplacement[] {
  const replacements: CaptureReplacement[] = [];

  const append = (match: RegExpExecArray): void => {
    replacements.push({
      index: match.index,
      matchLength: match[0].length,
      replacement: substituteRegexCapturesFromArrayLike(
        template,
        match[0],
        match,
        1,
        match.index,
        input,
        match.groups,
      ),
    });
  };

  if (re.global || re.sticky) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      append(match);
      if (match[0].length === 0) re.lastIndex++;
    }
  } else {
    const match = re.exec(input);
    if (match) append(match);
  }

  return replacements;
}

export function runRegexRequest(data: RegexRequest): unknown {
  const re = new RegExp(data.pattern, data.flags);

  if (data.op === "replace") {
    return data.input.replace(re, data.replacement);
  }

  if (data.op === "test") {
    let matches = 0;
    const counter = new RegExp(re.source, re.flags);
    data.input.replace(counter, (...args) => {
      matches++;
      return String(args[0] ?? "");
    });
    const result = data.input.replace(re, data.replacement);
    return { result, matches };
  }

  if (data.op === "collect") {
    return collectMatches(data.input, re);
  }

  if (data.op === "capture-replacements") {
    return collectCaptureReplacements(data.input, re, data.replacement);
  }

  throw new Error(`Unknown regex op: ${(data as { op: string }).op}`);
}
