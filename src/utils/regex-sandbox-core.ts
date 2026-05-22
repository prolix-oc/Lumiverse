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

export type RegexRequest = RegexReplaceRequest | RegexTestRequest | RegexCollectRequest;

export interface CollectedMatch {
  fullMatch: string;
  index: number;
  groups: (string | undefined)[];
  namedGroups?: Record<string, string>;
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

  throw new Error(`Unknown regex op: ${(data as { op: string }).op}`);
}
