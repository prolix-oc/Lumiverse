const HEAL_TOKEN_PREFIX = "\u0000LUMI_HEAL_";
const HEAL_TOKEN_SUFFIX = "_\u0000";

const FENCED_CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;
const INLINE_CODE_RE = /(`+)([\s\S]*?)\1/g;
const FONT_QUOTE_EDGE_RE = /(<font\b[^>]*>)(["“”«»])([\s\S]*?)(<\/font>)(["“”«»])/gi;
const COLOR_SPAN_QUOTE_EDGE_RE = /(<span\b[^>]*\bstyle\s*=\s*["'][^"']*\bcolor\s*:[^"']*["'][^>]*>)(["“”«»])([\s\S]*?)(<\/span>)(["“”«»])/gi;
const QUOTE_CHARS = new Set(['"', "“", "”", "«", "»"]);
const STRAIGHT_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(")([^\n]*?)(")(?=$|[\s)\]},.!?:;"'”’»<—–-])/g;
const CURLY_DOUBLE_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(“)([^\n]*?)(”)(?=$|[\s)\]},.!?:;"'”’»<—–-])/g;
const ANGLE_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(«)([^\n]*?)(»)(?=$|[\s)\]},.!?:;"'”’»<—–-])/g;

function shieldMatches(text: string, pattern: RegExp, bucket: string[]): string {
  return text.replace(pattern, (match) => {
    const token = `${HEAL_TOKEN_PREFIX}${bucket.length}${HEAL_TOKEN_SUFFIX}`;
    bucket.push(match);
    return token;
  });
}

function unshieldMatches(text: string, bucket: string[]): string {
  return text.replace(/\u0000LUMI_HEAL_(\d+)_\u0000/g, (match, rawIndex: string) => {
    const value = bucket[Number(rawIndex)];
    return value ?? match;
  });
}

function repairQuotedColorTagBoundaries(text: string): string {
  const repair = (
    _: string,
    openTag: string,
    openQuote: string,
    inner: string,
    closeTag: string,
    closeQuote: string,
  ) => {
    const trimmedInner = inner.trimEnd();
    const lastChar = trimmedInner[trimmedInner.length - 1];
    if (lastChar && QUOTE_CHARS.has(lastChar)) return _;
    return `${openTag}${openQuote}${inner}${closeQuote}${closeTag}`;
  };

  let healed = text.replace(FONT_QUOTE_EDGE_RE, repair);
  healed = healed.replace(COLOR_SPAN_QUOTE_EDGE_RE, repair);
  return healed;
}

function trimEdgeWhitespaceInEmphasis(text: string, delimiter: "*" | "_"): string {
  const delimiters = [3, 2, 1] as const;
  let result = text;

  for (const size of delimiters) {
    const marker = delimiter.repeat(size).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(^|[\\s([{"'“‘«>—–-])(${marker})(?!\\${delimiter})([^\\n]*?)${marker}(?!\\${delimiter})(?=$|[\\s)\\]},.!?:;"'”’»<—–-])`,
      "g",
    );
    result = result.replace(pattern, (match, prefix: string, openingMarker: string, body: string) => {
      if (!/^[ \t]+|[ \t]+$/.test(body)) return match;
      if (body.includes(delimiter)) return match;
      const trimmed = body.replace(/^[ \t]+|[ \t]+$/g, "");
      if (!trimmed) return match;
      if (!/[\p{L}\p{N}]/u.test(trimmed)) return match;
      return `${prefix}${openingMarker}${trimmed}${openingMarker}`;
    });
  }

  return result;
}

function trimEdgeWhitespaceInQuotes(text: string): string {
  const patterns = [STRAIGHT_QUOTE_RE, CURLY_DOUBLE_QUOTE_RE, ANGLE_QUOTE_RE];
  let result = text;

  for (const pattern of patterns) {
    result = result.replace(pattern, (match, prefix: string, openQuote: string, body: string, closeQuote: string) => {
      if (!/^[ \t]+|[ \t]+$/.test(body)) return match;
      const trimmed = body.replace(/^[ \t]+|[ \t]+$/g, "");
      if (!trimmed) return match;
      if (!/[\p{L}\p{N}]/u.test(trimmed)) return match;
      return `${prefix}${openQuote}${trimmed}${closeQuote}`;
    });
  }

  return result;
}

function healUnshieldedSegment(text: string): string {
  let healed = repairQuotedColorTagBoundaries(text);
  for (let i = 0; i < 2; i++) {
    const next = trimEdgeWhitespaceInQuotes(trimEdgeWhitespaceInEmphasis(trimEdgeWhitespaceInEmphasis(healed, "*"), "_"));
    if (next === healed) break;
    healed = next;
  }
  return healed;
}

export function healFormattingArtifacts(text: string): string {
  if (!text) return text;

  const shielded: string[] = [];
  let working = shieldMatches(text, FENCED_CODE_RE, shielded);
  working = shieldMatches(working, INLINE_CODE_RE, shielded);
  working = healUnshieldedSegment(working);
  return unshieldMatches(working, shielded);
}
