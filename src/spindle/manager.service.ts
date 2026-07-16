import { getDb } from "../db/connection";
import { env } from "../env";
import type {
  SpindleManifest,
  SpindlePermission,
  SpindleCapability,
  ExtensionInfo,
} from "lumiverse-spindle-types";
import {
  validateIdentifier,
  isValidPermission,
  isValidCapability,
} from "lumiverse-spindle-types";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  renameSync,
  statSync,
  lstatSync,
  realpathSync,
  copyFileSync,
  cpSync,
  type Stats,
} from "fs";
import { join, resolve, dirname, sep, extname } from "path";
import { getUserExtensionPath } from "../auth/provision";
import { spawnAsync, type SpawnAsyncResult } from "./spawn-async";
import {
  BLOCKED_BUN_API_LABELS,
  BLOCKED_GLOBAL_API_LABELS,
  BLOCKED_MODULE_SPECIFIER_LABELS,
  DANGEROUS_PROCESS_API_NAMES,
} from "./dangerous-runtime-policy";
import { normalizeSpindleHttpsUrl } from "./url-safety";
import { bunCmd } from "../utils/bun-cmd";

export type InstallScope = "operator" | "user";
function isManagedPermission(permission: string): permission is SpindlePermission {
  return isValidPermission(permission);
}

type SourceSpan = { start: number; end: number };
type ScannerOrigin = string;
type ScannerBindingUpdate = { position: number; values: Set<ScannerOrigin> };
type ScannerBinding = {
  updates: ScannerBindingUpdate[];
};
type ScannerBindingScope = {
  start: number;
  end: number;
  parent: ScannerBindingScope | null;
  children: ScannerBindingScope[];
  bindings: Map<string, ScannerBinding>;
  functionBoundary: boolean;
  id: number;
};
type ScannerLexicalContext = {
  root: ScannerBindingScope;
  scopes: ScannerBindingScope[];
  scopeIds: Int32Array;
  overflowSpans: SourceSpan[];
  parameterSpans: SourceSpan[];
  resolveValues: (name: string, position: number) => Set<ScannerOrigin>;
  resolveExpression: (raw: string, position: number) => Set<ScannerOrigin>;
  scopeAt: (position: number) => ScannerBindingScope;
  isOverflowed: (position: number) => boolean;
};
type ScannerBindingChecker = (name: string, position: number) => boolean;
type ScannerDelimiterMap = {
  openingToClosing: Map<number, number>;
  closingToOpening: Map<number, number>;
};
type ScannerContext = {
  maskedText?: string;
  delimiterMap?: ScannerDelimiterMap;
  bindingChecker?: ScannerBindingChecker;
  lexical?: ScannerLexicalContext;
  tokenPresence: Map<string, boolean>;
  aliasSets: Map<string, Set<string>>;
};
type ScannableSource = {
  text: string;
  ignoredSpans: SourceSpan[];
  context: ScannerContext;
};

function getMaskedSource(source: ScannableSource): string {
  const cached = source.context.maskedText;
  if (cached !== undefined) return cached;
  const masked = maskIgnoredSpans(source.text, source.ignoredSpans);
  source.context.maskedText = masked;
  return masked;
}

function hasSourceToken(source: ScannableSource, token: string): boolean {
  const cached = source.context.tokenPresence.get(token);
  if (cached !== undefined) return cached;
  const present = source.text.includes(token);
  source.context.tokenPresence.set(token, present);
  return present;
}

function hasAnySourceToken(source: ScannableSource, tokens: readonly string[]): boolean {
  for (const token of tokens) {
    if (hasSourceToken(source, token)) return true;
  }
  return false;
}

function getDelimiterMap(source: ScannableSource): ScannerDelimiterMap {
  const cached = source.context.delimiterMap;
  if (cached) return cached;
  const delimiterMap = buildDelimiterMap(source);
  source.context.delimiterMap = delimiterMap;
  return delimiterMap;
}


const EXECUTABLE_MODULE_SPECIFIER_LABEL = "module loading";
const MODULE_COMMENT_GAP = String.raw`(?:\s|/\*(?:(?!\*/)[\s\S])*\*/|//[^\r\n]*(?:\r?\n|$))*`;

function isExecutableModuleSpecifier(specifier: string): boolean {
  const trimmed = specifier.trim();
  return (
    /^(?:data|blob|file|http|https):/i.test(trimmed) ||
    /^[/\\]/.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}
function isNativeAddonModuleSpecifier(specifier: string): boolean {
  const withoutQueryOrHash = specifier.trim().split(/[?#]/, 1)[0] ?? "";
  return /\.node$/i.test(withoutQueryOrHash);
}


function addModuleSpecifierHit(specifier: string, hits: Set<string>): void {
  if (isExecutableModuleSpecifier(specifier) || isNativeAddonModuleSpecifier(specifier)) {
    hits.add(EXECUTABLE_MODULE_SPECIFIER_LABEL);
  }
  const label = BLOCKED_MODULE_SPECIFIER_LABELS.get(specifier.trim());
  if (label) hits.add(label);
}

const DANGEROUS_BUN_PROPERTIES = BLOCKED_BUN_API_LABELS;
const DANGEROUS_PROCESS_PROPERTIES = new Map<string, string>(
  DANGEROUS_PROCESS_API_NAMES.map((name) => [name, "dangerous process API usage"] as const),
);
const WINDOWS_SPINDLE_ASYNC_BUN_OVERRIDE = "LUMIVERSE_FORCE_SPINDLE_ASYNC_BUN";
const warnedWindowsSpindleBunFallback = new Set<string>();

function normalizeJavaScriptForSafetyScan(content: string): string {
  try {
    return new Bun.Transpiler({ loader: "js" }).transformSync(content);
  } catch {
    return content;
  }
}

function collectIgnoredSpans(source: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const len = source.length;
  const addSpan = (start: number, end: number) => {
    if (end > start) spans.push({ start, end });
  };

  const skipQuoted = (start: number, quote: "'" | '"', end: number): number => {
    let i = start + 1;
    while (i < end) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === quote) {
        addSpan(start, i + 1);
        return i + 1;
      }
      i += 1;
    }
    addSpan(start, end);
    return end;
  };

  const scanTemplate = (start: number, end: number): number => {
    let i = start + 1;
    let textStart = start;
    while (i < end) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === "`") {
        addSpan(textStart, i + 1);
        return i + 1;
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        addSpan(textStart, i + 2);
        i = scanCode(i + 2, end, true);
        if (source[i] !== "}") return i;
        textStart = i;
        i += 1;
        continue;
      }
      i += 1;
    }
    addSpan(textStart, end);
    return end;
  };

  // Tokens after which a `/` starts a regex literal rather than division.
  // Conservative: only single-char operators / openers and a closed set of
  // keywords. The fallthrough is "treat as division" — false negatives in
  // regex detection just leave the existing behaviour intact (substrings
  // inside regex bodies remain scannable), so the heuristic only needs to
  // be RIGHT about value-producing tokens to avoid swallowing real code.
  const REGEX_CONTEXT_CHARS = new Set([
    "(", ",", "=", "!", "&", "|", "?", ":", ";", "{", "[", "}",
    "+", "-", "*", "%", "~", "^", "<", ">",
  ]);
  const REGEX_CONTEXT_KEYWORDS = new Set([
    "return", "typeof", "delete", "void", "throw", "new",
    "in", "of", "instanceof", "case", "do", "else", "yield", "await",
  ]);
  const previousCodeIndex = (from: number): number => {
    let index = from;
    while (index >= 0) {
      const ignored = ignoredSpanAt(index, spans);
      if (ignored) {
        index = ignored.start - 1;
        continue;
      }
      if (/\s/.test(source[index] ?? "")) {
        index -= 1;
        continue;
      }
      return index;
    }
    return -1;
  };
  const isObjectLiteralOpening = (opening: number): boolean => {
    const previous = previousCodeIndex(opening - 1);
    if (previous < 0) return false;
    const previousChar = source[previous];
    if (previousChar === ">") {
      return source[previous - 1] !== "=";
    }
    if ("=(:,[!?&|+-*%^~<>".includes(previousChar)) return true;
    if (/[A-Za-z0-9_$)\]}]/.test(previousChar ?? "")) {
      let end = previous;
      while (end >= 0 && /[A-Za-z0-9_$]/.test(source[end] ?? "")) end -= 1;
      const word = source.slice(end + 1, previous + 1);
      return new Set(["return", "throw", "yield", "await"]).has(word);
    }
    return false;
  };
  const isObjectLiteralClosing = (closing: number): boolean => {
    let depth = 0;
    let index = closing;
    while (index >= 0) {
      const ignored = ignoredSpanAt(index, spans);
      if (ignored) {
        index = ignored.start - 1;
        continue;
      }
      const char = source[index];
      if (char === "}") {
        depth += 1;
      } else if (char === "{") {
        depth -= 1;
        if (depth === 0) return isObjectLiteralOpening(index);
      }
      index -= 1;
    }
    return false;
  };


  /**
   * Find the last non-whitespace, non-comment character before `pos` and
   * decide whether a `/` at `pos` starts a regex literal. Walks backwards
   * skipping whitespace, single-line comments (which we've already
   * registered as spans, but they don't exist yet at this scan position —
   * scanCode runs forward), and identifier characters (to detect keyword
   * tokens like `return`).
   *
   * Returns true if `pos` is regex-context, false if it's division-context.
   * Defaults to true at start-of-input (a leading `/` is a regex).
   */
  const isRegexContext = (pos: number): boolean => {
    let j = pos - 1;
    // Skip whitespace.
    while (j >= 0 && /\s/.test(source[j])) j -= 1;
    if (j < 0) return true;
    const ch = source[j];
    if (ch === "}") return !isObjectLiteralClosing(j);
    if (REGEX_CONTEXT_CHARS.has(ch)) return true;
    // Identifier scan — keyword or value?
    if (/[A-Za-z_$]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k] ?? "")) k -= 1;
      const word = source.slice(k + 1, j + 1);
      if (REGEX_CONTEXT_KEYWORDS.has(word)) return true;
      return false;
    }
    // Closing `)`, `]`, `++`, `--`, etc. — value context, treat as division.
    return false;
  };

  /**
   * Scan a regex literal starting at `start` (the leading `/`). Returns the
   * index past the closing `/` and any flag characters. Respects character
   * classes (`[...]` can contain `/` literally) and `\` escapes.
   */
  const scanRegex = (start: number, end: number): number => {
    let i = start + 1;
    let inClass = false;
    while (i < end) {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        i += 1;
        continue;
      }
      if (ch === "]" && inClass) {
        inClass = false;
        i += 1;
        continue;
      }
      if (ch === "/" && !inClass) {
        i += 1;
        // Consume regex flags.
        while (i < end && /[dgimsuy]/.test(source[i])) i += 1;
        addSpan(start, i);
        return i;
      }
      if (ch === "\n") {
        // Unterminated regex on a single line — bail out, leave the rest
        // scannable. (Real JS would have rejected this at parse time.)
        return start + 1;
      }
      i += 1;
    }
    addSpan(start, end);
    return end;
  };

  const scanCode = (start: number, end: number, stopOnTemplateBrace = false): number => {
    let i = start;
    while (i < end) {
      if (stopOnTemplateBrace && source[i] === "}") return i;
      if (source[i] === "/" && source[i + 1] === "/") {
        const lineEnd = source.indexOf("\n", i + 2);
        const commentEnd = lineEnd === -1 ? end : lineEnd;
        addSpan(i, commentEnd);
        i = commentEnd;
        continue;
      }
      if (source[i] === "/" && source[i + 1] === "*") {
        const blockEnd = source.indexOf("*/", i + 2);
        const commentEnd = blockEnd === -1 ? end : blockEnd + 2;
        addSpan(i, commentEnd);
        i = commentEnd;
        continue;
      }
      // Regex literal — disambiguated from division by preceding-token check.
      // Bundle minifiers preserve regex literals (`/pat/flags`), and several
      // legitimate extensions inline a regex whose source string mentions
      // forbidden tokens (e.g. lumiscript's host-dispatcher security check
      // `/(?<!\.)\b(?:new\s+)?Function\s*\(/.test(t)`). Without this branch
      // the scanner reads the regex source as raw code and false-positives.
      if (source[i] === "/" && isRegexContext(i)) {
        i = scanRegex(i, end);
        continue;
      }
      if (source[i] === '"' || source[i] === "'") {
        i = skipQuoted(i, source[i] as "'" | '"', end);
        continue;
      }
      if (source[i] === "`") {
        i = scanTemplate(i, end);
        continue;
      }
      i += 1;
    }
    return i;
  };

  scanCode(0, len);
  return spans.sort((a, b) => a.start - b.start);
}

function isIgnoredIndex(index: number | undefined, spans: SourceSpan[]): boolean {
  return ignoredSpanAt(index, spans) !== null;
}

function ignoredSpanAt(index: number | undefined, spans: SourceSpan[]): SourceSpan | null {
  if (index === undefined || index < 0) return null;
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const span = spans[middle];
    if (index < span.start) {
      high = middle - 1;
    } else if (index >= span.end) {
      low = middle + 1;
    } else {
      return span;
    }
  }
  return null;
}
function maskIgnoredSpans(text: string, spans: SourceSpan[]): string {
  const characters = text.split("");
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return characters.join("");
}

let lastScannableContent: string | undefined;
let lastScannableSources: ScannableSource[] | undefined;

function createScannableSources(content: string): ScannableSource[] {
  if (content === lastScannableContent && lastScannableSources) return lastScannableSources;
  const normalized = normalizeJavaScriptForSafetyScan(content);
  const texts = normalized === content ? [content] : [content, normalized];
  const sources = texts.map((text) => ({
    text,
    ignoredSpans: collectIgnoredSpans(text),
    context: {
      tokenPresence: new Map<string, boolean>(),
      aliasSets: new Map<string, Set<string>>(),
    },
  }));
  lastScannableContent = content;
  lastScannableSources = sources;
  return sources;
}

function matchOutsideIgnored(source: ScannableSource, regex: RegExp): RegExpMatchArray[] {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(regex.source, flags);
  const matches: RegExpMatchArray[] = [];
  for (const match of source.text.matchAll(globalRegex)) {
    if (!isIgnoredIndex(match.index, source.ignoredSpans)) matches.push(match);
  }
  return matches;
}

function decodeJavaScriptStringBody(body: string): string | null {
  let decoded = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    if (index + 1 >= body.length) return null;
    const escaped = body[++index];
    switch (escaped) {
      case "b":
        decoded += "\b";
        break;
      case "f":
        decoded += "\f";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "v":
        decoded += "\v";
        break;
      case "0":
        decoded += "\0";
        if (/[0-9]/.test(body[index + 1] ?? "")) decoded += body[++index];
        break;
      case "x": {
        const hex = body.slice(index + 1, index + 3);
        if (!/^[\da-fA-F]{2}$/.test(hex)) return null;
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case "u": {
        if (body[index + 1] === "{") {
          const close = body.indexOf("}", index + 2);
          if (close < 0) return null;
          const codePoint = body.slice(index + 2, close);
          if (!/^[\da-fA-F]{1,6}$/.test(codePoint)) return null;
          const value = Number.parseInt(codePoint, 16);
          if (value > 0x10ffff) return null;
          decoded += String.fromCodePoint(value);
          index = close;
          break;
        }
        const hex = body.slice(index + 1, index + 5);
        if (!/^[\da-fA-F]{4}$/.test(hex)) return null;
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      case "\n":
        break;
      case "\r":
        if (body[index + 1] === "\n") index += 1;
        break;
      default:
        decoded += escaped;
        break;
    }
  }
  return decoded;
}

function decodeQuotedLiteral(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.test(trimmed)) {
    return null;
  }
  return decodeJavaScriptStringBody(trimmed.slice(1, -1));
}

function decodeSimpleStringExpression(raw: string): string | null {
  const trimmed = raw.trim();
  const direct = decodeQuotedLiteral(trimmed);
  if (direct !== null) return direct;

  const charCode = trimmed.match(/^String\.fromCharCode\s*\(([^)]*)\)$/);
  if (charCode) {
    const chars = charCode[1]
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 0x10ffff);
    if (chars.length > 0) return String.fromCodePoint(...chars);
  }

  const literalParts = [...trimmed.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)].map((match) => {
    if (match[3] !== undefined) return match[3].replace(/\$\{[^}]*\}/g, "");
    if (match[1] !== undefined) return decodeQuotedLiteral(`"${match[1]}"`) ?? "";
    return decodeQuotedLiteral(`'${match[2]}'`) ?? "";
  });
  return literalParts.length > 0 ? literalParts.join("") : null;
}

function stripModuleExpressionComments(raw: string): string | null {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote) {
      result += char;
      if (char === "\\") {
        result += raw[++i] ?? "";
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
      continue;
    }
    if (char === "/" && raw[i + 1] === "/") {
      const end = raw.indexOf("\n", i + 2);
      if (end < 0) break;
      result += " ";
      i = end - 1;
      continue;
    }
    if (char === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      if (end < 0) return null;
      result += " ";
      i = end + 1;
      continue;
    }
    result += char;
  }
  return quote ? null : result;
}

/**
 * Resolve a dynamic `import()` / `require()` specifier ONLY when the entire
 * expression is a provably-constant string: a single string literal, a `+`
 * concatenation of string literals, or `String.fromCharCode(<int literals>)`.
 * Returns the resolved module string, or `null` if any part is non-constant
 * (template interpolation `${…}`, a variable, member/computed access, a
 * function call, etc.).
 *
 * This is deliberately STRICTER than {@link decodeSimpleStringExpression},
 * which strips `${…}` and concatenates whatever literals it can find — that
 * leniency let a specifier like `` `node:${seg}` `` decode to the harmless
 * "node:" and slip past the dangerous-module check. The import/require gate
 * must fail CLOSED: anything we cannot fully prove constant is reported as
 * "dynamic module access" and hard-blocked (there is no capability opt-in,
 * because the unresolved string could be `node:fs`, `child_process`, etc.).
 */
function resolveStaticModuleSpecifier(raw: string): string | null {
  const withoutComments = stripModuleExpressionComments(raw);
  if (withoutComments === null) return null;
  const trimmed = withoutComments.trim();
  if (!trimmed) return null;

  // `String.fromCharCode(<int literals>)` — constant only when every argument
  // is an integer literal (a variable arg makes the whole call non-constant).
  const charCode = trimmed.match(/^String\.fromCharCode\s*\(([^)]*)\)$/);
  if (charCode) {
    const parts = charCode[1].split(",").map((p) => p.trim());
    if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
    const codes = parts.map(Number);
    if (codes.some((n) => !Number.isInteger(n) || n < 0 || n > 0x10ffff)) return null;
    return String.fromCodePoint(...codes);
  }

  // One or more string literals joined by `+`. A template literal is accepted
  // only when it contains NO `${…}` interpolation (`\$(?!\{)` allows a bare
  // `$`, but `${` ends the literal match and forces a `null` "dynamic" result).
  const LITERAL = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)/;
  let rest = trimmed;
  let value = "";
  let matchedAny = false;
  while (rest) {
    const m = rest.match(LITERAL);
    if (!m) return null;
    const decoded = decodeQuotedLiteral(m[0]);
    if (decoded === null) return null;
    value += decoded;
    matchedAny = true;
    rest = rest.slice(m[0].length).replace(/^\s+/, "");
    if (!rest) break;
    // `import(spec, { with: … })` — the specifier is complete; the trailing
    // comma introduces the (static) import-attributes object, not part of it.
    if (rest[0] === ",") break;
    if (rest[0] !== "+") return null; // any non-`+` operator/token ⇒ dynamic
    rest = rest.slice(1).replace(/^\s+/, "");
    if (!rest) return null; // dangling `+`
  }
  return matchedAny ? value : null;
}
/**
 * Resolve a complete static string expression for serialized global-object
 * property keys. Unlike module-call resolution, this deliberately rejects
 * import attributes and every other trailing token instead of accepting a
 * comma-delimited prefix.
 */
function resolveStrictStaticStringExpression(raw: string): string | null {
  const withoutComments = stripModuleExpressionComments(raw);
  if (withoutComments === null) return null;
  const trimmed = withoutComments.trim();
  if (!trimmed) return null;

  const charCode = trimmed.match(/^String\.fromCharCode\s*\(([^)]*)\)$/);
  if (charCode) {
    const parts = charCode[1].split(",").map((part) => part.trim());
    if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return null;
    const codes = parts.map(Number);
    if (codes.some((code) => !Number.isInteger(code) || code < 0 || code > 0x10ffff)) return null;
    return String.fromCodePoint(...codes);
  }

  const LITERAL = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)/;
  let rest = trimmed;
  let value = "";
  let matchedAny = false;
  while (rest) {
    const match = rest.match(LITERAL);
    if (!match) return null;
    const decoded = decodeQuotedLiteral(match[0]);
    if (decoded === null) return null;
    value += decoded;
    matchedAny = true;
    rest = rest.slice(match[0].length).replace(/^\s+/, "");
    if (!rest) break;
    if (rest[0] !== "+") return null;
    rest = rest.slice(1).replace(/^\s+/, "");
    if (!rest) return null;
  }
  return matchedAny ? value : null;
}
function normalizeIdentifierExpression(raw: string): string | null {
  const withoutComments = stripModuleExpressionComments(raw);
  if (withoutComments === null) return null;
  let value = withoutComments.trim();
  for (let pass = 0; pass < 8 && value.startsWith("(") && value.endsWith(")"); pass += 1) {
    let depth = 0;
    let outerClose = -1;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "(") depth += 1;
      else if (value[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          outerClose = index;
          break;
        }
        if (depth < 0) break;
      }
    }
    if (outerClose !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : null;
}
const MODULE_LITERAL_RE =
  /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)/;
const STATIC_MODULE_IMPORT_RE = new RegExp(
  `\\b(?:import|export)${MODULE_COMMENT_GAP}(?:(?:[^;\\n]*?${MODULE_COMMENT_GAP}from${MODULE_COMMENT_GAP})?(${MODULE_LITERAL_RE.source}))`,
  "g",
);
const MODULE_CALL_ARGUMENT_MAX_LENGTH = 65_536;
const MODULE_CALL_ARGUMENT_FRAGMENT =
  `((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\)){1,${MODULE_CALL_ARGUMENT_MAX_LENGTH}}?)`;
const BARE_MODULE_CALL_PREFIX_RE = new RegExp(
  `(?<![.\\w$])(?:import${MODULE_COMMENT_GAP}|require${MODULE_COMMENT_GAP}(?:\\?\\.${MODULE_COMMENT_GAP})?)\\(`,
  "g",
);

const BARE_MODULE_CALL_RE = new RegExp(
  `(?<![.\\w$])(?:import${MODULE_COMMENT_GAP}|require${MODULE_COMMENT_GAP}(?:\\?\\.${MODULE_COMMENT_GAP})?)\\(${MODULE_CALL_ARGUMENT_FRAGMENT}\\)`,
  "g",
);
const IMPORT_META_ALLOWED_PROPERTIES: Readonly<Record<string, true>> = {
  url: true,
  dir: true,
  file: true,
  path: true,
  main: true,
  resolve: true,
};
const IMPORT_META_RE = new RegExp(
  `\\bimport${MODULE_COMMENT_GAP}\\.${MODULE_COMMENT_GAP}meta\\b`,
  "g",
);
const IMPORT_META_PROPERTY_RE = new RegExp(
  `^${MODULE_COMMENT_GAP}(?:(?:\\.${MODULE_COMMENT_GAP}|\\?\\.${MODULE_COMMENT_GAP})([A-Za-z_$][\\w$]*)|(?:\\?\\.${MODULE_COMMENT_GAP})?\\[([^\\]]{1,${MODULE_CALL_ARGUMENT_MAX_LENGTH}})\\])`,
);
const IMPORT_META_CALL_PREFIX_RE = new RegExp(
  `^${MODULE_COMMENT_GAP}(?:\\?\\.${MODULE_COMMENT_GAP})?\\(`,
);
const IMPORT_META_CALL_RE = new RegExp(
  `^${MODULE_COMMENT_GAP}(?:\\?\\.${MODULE_COMMENT_GAP})?\\(${MODULE_CALL_ARGUMENT_FRAGMENT}\\)`,
);

// `import.meta.require` is a module loader; every other metadata escape fails closed.
function addImportMetaRequireHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasSourceToken(source, "import")) return;
  for (const match of matchOutsideIgnored(source, IMPORT_META_RE)) {
    if (match.index === undefined) continue;
    const tail = source.text.slice(match.index + match[0].length);
    const propertyMatch = tail.match(IMPORT_META_PROPERTY_RE);
    if (!propertyMatch) {
      hits.add("dynamic module access");
      continue;
    }

    const property =
      propertyMatch[1] ?? resolveStrictStaticStringExpression(propertyMatch[2] ?? "");
    const afterProperty = tail.slice(propertyMatch[0].length);
    if (property === null) {
      hits.add("dynamic module access");
      continue;
    }
    if (Object.hasOwn(IMPORT_META_ALLOWED_PROPERTIES, property)) continue;
    if (property !== "require") {
      hits.add("dynamic module access");
      continue;
    }

    if (!IMPORT_META_CALL_PREFIX_RE.test(afterProperty)) {
      hits.add("dynamic module access");
      continue;
    }
    IMPORT_META_CALL_PREFIX_RE.lastIndex = 0;
    const call = afterProperty.match(IMPORT_META_CALL_RE);
    if (!call) {
      hits.add("dynamic module access");
      continue;
    }
    const resolved = resolveStaticModuleSpecifier(call[1]);
    if (resolved === null) {
      hits.add("dynamic module access");
    } else {
      addModuleSpecifierHit(resolved, hits);
    }
  }
}

function addStaticModuleHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasAnySourceToken(source, ["import", "export"])) return;
  for (const match of matchOutsideIgnored(source, STATIC_MODULE_IMPORT_RE)) {
    const specifier = decodeQuotedLiteral(match[1]);
    if (specifier !== null) addModuleSpecifierHit(specifier, hits);
  }
}

function addReachableModuleRequireHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasSourceToken(source, "require")) return;
  const requireMeta = new RegExp(
    `\\brequire${MODULE_COMMENT_GAP}(?:\\.|\\[)\\s*(?:main|cache)`,
    "g",
  );
  for (const match of matchOutsideIgnored(source, requireMeta)) {
    if (match.index === undefined || scannerIsLocal(source, "require", match.index)) continue;
    const tail = source.text.slice(match.index + match[0].length);
    const directRequire = new RegExp(
      `^${MODULE_COMMENT_GAP}(?:\\[[^\\]]+\\]${MODULE_COMMENT_GAP})?\\.${MODULE_COMMENT_GAP}require`,
    );
    if (directRequire.test(tail)) continue;
    hits.add("dynamic module access");
  }
  const indirectRequire = new RegExp(
    `(?<![.\\w$])require${MODULE_COMMENT_GAP}(?:\\.${MODULE_COMMENT_GAP}(?:main|cache)|\\[\\s*["'\\x60](?:main|cache)["'\\x60]\\s*\\])${MODULE_COMMENT_GAP}(?:\\[[^\\]]{1,300}\\]${MODULE_COMMENT_GAP})?\\.${MODULE_COMMENT_GAP}require${MODULE_COMMENT_GAP}\\(${MODULE_CALL_ARGUMENT_FRAGMENT}\\)`,
    "g",
  );
  for (const match of matchOutsideIgnored(source, indirectRequire)) {
    if (match.index === undefined || scannerIsLocal(source, "require", match.index)) continue;
    const resolved = resolveStaticModuleSpecifier(match[1]);
    if (resolved === null) hits.add("dynamic module access");
    else addModuleSpecifierHit(resolved, hits);
  }
}

const MODULE_CONSTRUCTOR_LOADER_LABEL = "module loading";

function createScannerBindingChecker(
  source: ScannableSource,
): ScannerBindingChecker {
  const cached = source.context.bindingChecker;
  if (cached) return cached;
  const masked = getMaskedSource(source);
  const root: ScannerBindingScope = {
    start: 0,
    end: masked.length,
    parent: null,
    children: [],
    bindings: new Map(),
    functionBoundary: true,
    id: 0,
  };
  const scopes: ScannerBindingScope[] = [root];
  const scopeIds = new Int32Array(masked.length);
  const stack: ScannerBindingScope[] = [root];
  const overflowSpans: SourceSpan[] = [];
  let overflowDepth = 0;
  let overflowStart = -1;
  const scopeLimit = GLOBAL_ALIAS_SCOPE_LIMIT;

  for (let index = 0; index < masked.length; index += 1) {
    scopeIds[index] = stack[stack.length - 1]?.id ?? 0;
    const char = masked[index];
    if (char === "{") {
      if (overflowDepth > 0) {
        overflowDepth += 1;
        continue;
      }
      if (scopes.length >= scopeLimit) {
        overflowDepth = 1;
        overflowStart = index;
        continue;
      }
      const parent = stack[stack.length - 1] ?? root;
      const child: ScannerBindingScope = {
        start: index,
        end: masked.length,
        parent,
        children: [],
        bindings: new Map(),
        functionBoundary: false,
        id: scopes.length,
      };
      parent.children.push(child);
      scopes.push(child);
      stack.push(child);
    } else if (char === "}") {
      if (overflowDepth > 0) {
        overflowDepth -= 1;
        if (overflowDepth === 0 && overflowStart >= 0) {
          overflowSpans.push({ start: overflowStart, end: index + 1 });
          overflowStart = -1;
        }
      } else if (stack.length > 1) {
        const closed = stack.pop();
        if (closed) closed.end = index + 1;
      }
    }
  }
  if (overflowDepth > 0 && overflowStart >= 0) {
    overflowSpans.push({ start: overflowStart, end: masked.length });
  }
  root.end = masked.length;

  const expressionScopes: ScannerBindingScope[] = [];
  const scopeAt = (position: number): ScannerBindingScope => {
    const bounded = Math.max(0, Math.min(scopeIds.length - 1, position));
    let current = scopes[scopeIds[bounded] ?? 0] ?? root;
    let low = 0;
    let high = expressionScopes.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = expressionScopes[middle];
      if (position < candidate.start) {
        high = middle - 1;
      } else if (position >= candidate.end) {
        low = middle + 1;
      } else {
        current = candidate;
        break;
      }
    }
    return current;
  };
  const isOverflowed = (position: number): boolean => {
    let low = 0;
    let high = overflowSpans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const span = overflowSpans[middle];
      if (position < span.start) high = middle - 1;
      else if (position >= span.end) low = middle + 1;
      else return true;
    }
    return false;
  };
  const cloneValues = (values: Iterable<ScannerOrigin>): Set<ScannerOrigin> =>
    new Set<ScannerOrigin>(values);
  const updateBinding = (
    scope: ScannerBindingScope,
    name: string,
    position: number,
    values: Iterable<ScannerOrigin>,
  ): void => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
    let binding = scope.bindings.get(name);
    if (!binding) {
      binding = { updates: [] };
      scope.bindings.set(name, binding);
    }
    const next = cloneValues(values);
    const existing = binding.updates.find((update) => update.position === position);
    if (existing) {
      existing.values = next;
    } else {
      binding.updates.push({ position, values: next });
      binding.updates.sort((left, right) => left.position - right.position);
    }
  };
  const declareBinding = (
    scope: ScannerBindingScope,
    name: string,
    position: number,
  ): void => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
    if (!scope.bindings.has(name)) updateBinding(scope, name, position, []);
  };
  const nearestFunctionScope = (scope: ScannerBindingScope): ScannerBindingScope => {
    let current = scope;
    while (current.parent && !current.functionBoundary) current = current.parent;
    return current;
  };
  const findBinding = (
    name: string,
    position: number,
  ): { scope: ScannerBindingScope; binding: ScannerBinding } | null => {
    let current: ScannerBindingScope | null = scopeAt(position);
    while (current) {
      const binding = current.bindings.get(name);
      if (binding) return { scope: current, binding };
      current = current.parent;
    }
    return null;
  };
  const valuesAt = (binding: ScannerBinding, position: number): Set<ScannerOrigin> => {
    let low = 0;
    let high = binding.updates.length - 1;
    let selected: Set<ScannerOrigin> | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const update = binding.updates[middle];
      if (update.position <= position) {
        selected = update.values;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return cloneValues(selected ?? []);
  };
  const intrinsic = (name: string): Set<ScannerOrigin> => {
    switch (name) {
      case "globalThis":
      case "self":
      case "global":
        return new Set(["global"]);
      case "module":
        return new Set(["module"]);
      case "require":
        return new Set(["module:require"]);
      case "eval":
        return new Set(["eval"]);
      case "Bun":
        return new Set(["bun"]);
      case "process":
        return new Set(["process"]);
      case "Reflect":
        return new Set(["reflect"]);
      case "Object":
        return new Set(["object"]);
      case "Function":
        return new Set(["function"]);
      case "AsyncFunction":
        return new Set(["asyncFunction"]);
      case "GeneratorFunction":
        return new Set(["generatorFunction"]);
      case "AsyncGeneratorFunction":
        return new Set(["asyncGeneratorFunction"]);
      default:
        return new Set();
    }
  };
  const resolveValues = (name: string, position: number): Set<ScannerOrigin> => {
    const found = findBinding(name, position);
    return found ? valuesAt(found.binding, position) : intrinsic(name);
  };
  const stripOuterParens = (raw: string): string => {
    let value = raw.trim();
    for (let pass = 0; pass < 8 && value.startsWith("(") && value.endsWith(")"); pass += 1) {
      let depth = 0;
      let closesAt = -1;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "(") depth += 1;
        else if (value[index] === ")" && --depth === 0) {
          closesAt = index;
          break;
        }
      }
      if (closesAt !== value.length - 1) break;
      value = value.slice(1, -1).trim();
    }
    return value;
  };
  const parseMemberPath = (raw: string): { root: string; properties: (string | null)[] } | null => {
    const stripped = stripOuterParens(stripModuleExpressionComments(raw) ?? raw);
    const rootMatch = stripped.match(/^([A-Za-z_$][\w$]*)/);
    if (!rootMatch) return null;
    const properties: (string | null)[] = [];
    let cursor = rootMatch[0].length;
    while (cursor < stripped.length) {
      while (/\s/.test(stripped[cursor] ?? "")) cursor += 1;
      let computed = false;
      if (stripped.startsWith("?.", cursor)) {
        cursor += 2;
        while (/\s/.test(stripped[cursor] ?? "")) cursor += 1;
        if (stripped[cursor] === "[") {
          computed = true;
          cursor += 1;
        }
      } else if (stripped[cursor] === ".") {
        cursor += 1;
      } else if (stripped[cursor] === "[") {
        computed = true;
        cursor += 1;
      } else {
        return null;
      }
      while (/\s/.test(stripped[cursor] ?? "")) cursor += 1;
      if (!computed) {
        const propertyMatch = stripped.slice(cursor).match(/^([A-Za-z_$][\w$]*)/);
        if (!propertyMatch) return null;
        properties.push(propertyMatch[1]);
        cursor += propertyMatch[0].length;
        continue;
      }
      let depth = 1;
      let closing = -1;
      for (let index = cursor; index < stripped.length; index += 1) {
        if (stripped[index] === "[") depth += 1;
        else if (stripped[index] === "]" && --depth === 0) {
          closing = index;
          break;
        }
      }
      if (closing < 0) return null;
      properties.push(resolveStrictStaticStringExpression(stripped.slice(cursor, closing)));
      cursor = closing + 1;
    }
    return { root: rootMatch[1], properties };
  };
  const propertyValues = (
    values: Set<ScannerOrigin>,
    property: string | null,
  ): Set<ScannerOrigin> => {
    const output = new Set<ScannerOrigin>();
    for (const value of values) {
      if (property === null) {
        if (value === "global") output.add("global:*");
        else if (value === "module") output.add("module:*");
        else if (value === "bun") output.add("bun:*");
        else if (value === "process") output.add("process:*");
        else if (value === "reflect") output.add("reflect:*");
        else if (value === "object") output.add("object:*");
        else if (value === "module:require:meta") output.add("module:require");
        else output.add(`${value}:*`);
        continue;
      }
      if (value === "global") {
        if (property === "module" || property === "globalThis" || property === "self" || property === "global") {
          output.add(property === "module" ? "module" : "global");
        } else {
          output.add(`global:${property}`);
        }
      } else if (value === "module") {
        output.add(
          property === "constructor"
            ? "module:constructor"
            : property === "createRequire"
              ? "module:createRequire"
              : property === "require" || property === "_load"
                ? "module:require"
                : `module:${property}`,
        );
      } else if (value === "module:constructor") {
        output.add(
          property === "_load" || property === "createRequire" || property === "require"
            ? "module:constructor"
            : "module:*",
        );
      } else if (value === "module:require") {
        if (property === "main" || property === "cache") {
          output.add("module:require:meta");
        } else if (property === "require") {
          output.add("module:require");
        } else {
          output.add("module:*");
        }
      } else if (value === "module:require:meta") {
        if (property === "require") output.add("module:require");
        else output.add("module:*");
      } else if (value === "bun") {
        output.add(`bun:${property}`);
      } else if (value === "process") {
        output.add(`process:${property}`);
      } else if (value === "reflect") {
        output.add(`reflect:${property}`);
      } else if (value === "object") {
        output.add(`object:${property}`);
      } else if (value === "eval" || value === "function" || value.endsWith("Function")) {
        output.add(value);
      } else if (value === "global:*" || value === "module:*") {
        output.add(value);
      } else if (
        value.startsWith("global:") ||
        value.startsWith("reflect:") ||
        value.startsWith("object:")
      ) {
        output.add(value);
      } else {
        output.add(`${value}:${property}`);
      }
    }
    return output;
  };
  const resolveExpression = (raw: string, position: number): Set<ScannerOrigin> => {
    const cleaned = stripOuterParens(stripModuleExpressionComments(raw) ?? raw);
    if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
      const values = new Set<ScannerOrigin>();
      for (const entry of splitTopLevelExpressionList(cleaned.slice(1, -1)) ?? []) {
        for (const value of resolveExpression(entry, position)) values.add(value);
      }
      return values;
    }
    const reflected = cleaned.match(
      /^([A-Za-z_$][\w$]*)\s*(?:\.\s*|\[\s*["'`](get|getOwnPropertyDescriptor)["'`]\s*\]\s*)\s*(get|getOwnPropertyDescriptor)?\s*\(([^,]+),([\s\S]*)\)(?:\s*\.\s*value)?$/,
    );
    if (reflected) {
      const rootValues = resolveValues(reflected[1], position);
      const method = reflected[2] ?? reflected[3];
      if (
        method === "get" ||
        method === "getOwnPropertyDescriptor"
      ) {
        const receiverValues = resolveExpression(reflected[4], position);
        const property = resolveStrictStaticStringExpression(reflected[5]);
        if (scannerOriginHas(rootValues, "reflect") || scannerOriginHas(rootValues, "object")) {
          return propertyValues(receiverValues, property);
        }
      }
    }
    const path = parseMemberPath(cleaned);
    if (!path) return new Set();
    let values = resolveValues(path.root, position);
    const shadowedString =
      /\bString\s*\.\s*fromCharCode\s*\(/.test(cleaned) &&
      scannerIsLocal(source, "String", position);
    for (const property of path.properties) {
      values = propertyValues(values, shadowedString ? null : property);
    }
    return values;
  };
  const pending: Array<{
    pattern: string;
    rhs: string;
    position: number;
    scope: ScannerBindingScope;
  }> = [];
  const splitPattern = (raw: string): string[] =>
    splitTopLevelExpressionList(stripModuleExpressionComments(raw) ?? raw) ?? raw.split(",");
  const topLevelIndex = (raw: string, wanted: string): number => {
    const value = stripModuleExpressionComments(raw) ?? raw;
    const stack: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if ("([{".includes(char)) stack.push(char);
      else if (")]}".includes(char)) stack.pop();
      else if (char === wanted && stack.length === 0) return index;
    }
    return -1;
  };
  const patternEntries = (
    raw: string,
    defaultValues: Set<ScannerOrigin> = new Set(),
  ): Array<{ name: string; values: Set<ScannerOrigin> }> => {
    let pattern = (stripModuleExpressionComments(raw) ?? raw).trim();
    while (pattern.startsWith("...")) pattern = pattern.slice(3).trim();
    const defaultAt = topLevelIndex(pattern, "=");
    if (defaultAt >= 0) {
      const defaultRaw = pattern.slice(defaultAt + 1).trim();
      const resolvedDefault = resolveExpression(defaultRaw, 0);
      return patternEntries(pattern.slice(0, defaultAt), resolvedDefault);
    }
    if (pattern.startsWith("{") && pattern.endsWith("}")) {
      const result: Array<{ name: string; values: Set<ScannerOrigin> }> = [];
      for (const entry of splitPattern(pattern.slice(1, -1))) {
        const colon = topLevelIndex(entry, ":");
        result.push(
          ...patternEntries(colon >= 0 ? entry.slice(colon + 1) : entry, defaultValues),
        );
      }
      return result;
    }
    if (pattern.startsWith("[") && pattern.endsWith("]")) {
      return splitPattern(pattern.slice(1, -1)).flatMap((entry) => patternEntries(entry, defaultValues));
    }
    const name = pattern.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    return name ? [{ name, values: cloneValues(defaultValues) }] : [];
  };
  const mapPatternValues = (
    raw: string,
    values: Set<ScannerOrigin>,
    position: number,
  ): Array<{ name: string; values: Set<ScannerOrigin> }> => {
    let pattern = (stripModuleExpressionComments(raw) ?? raw).trim();
    while (pattern.startsWith("...")) pattern = pattern.slice(3).trim();
    const defaultAt = topLevelIndex(pattern, "=");
    if (defaultAt >= 0) {
      const combined = cloneValues(values);
      for (const value of resolveExpression(pattern.slice(defaultAt + 1), position)) {
        combined.add(value);
      }
      return mapPatternValues(pattern.slice(0, defaultAt), combined, position);
    }
    if (pattern.startsWith("{") && pattern.endsWith("}")) {
      const result: Array<{ name: string; values: Set<ScannerOrigin> }> = [];
      for (const entry of splitPattern(pattern.slice(1, -1))) {
        const colon = topLevelIndex(entry, ":");
        const rawKey = (colon < 0 ? entry : entry.slice(0, colon)).trim();
        const child = colon < 0 ? entry : entry.slice(colon + 1);
        const childDefaultAt = colon < 0 ? topLevelIndex(child, "=") : -1;
        const bindingPattern =
          childDefaultAt >= 0 ? child.slice(0, childDefaultAt).trim() : child;
        const key = rawKey.startsWith("[")
          ? resolveStrictStaticStringExpression(rawKey.slice(1, -1))
          : rawKey.split(/\s*=/, 1)[0]?.trim() ?? "";
        const propertyBase = propertyValues(values, key || null);
        if (childDefaultAt >= 0) {
          const defaultValues = resolveExpression(
            child.slice(childDefaultAt + 1),
            position,
          );
          for (const value of defaultValues) propertyBase.add(value);
        }
        result.push(...mapPatternValues(bindingPattern, propertyBase, position));
      }
      return result;
    }
    if (pattern.startsWith("[") && pattern.endsWith("]")) {
      return splitPattern(pattern.slice(1, -1)).flatMap((entry) =>
        mapPatternValues(entry, propertyValues(values, null), position),
      );
    }
    const name = pattern.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    return name ? [{ name, values: cloneValues(values) }] : [];
  };
  const declarePattern = (
    raw: string,
    scope: ScannerBindingScope,
    position: number,
  ): void => {
    for (const { name } of patternEntries(raw)) declareBinding(scope, name, position);
  };
  const nextCode = (start: number): number => {
    let index = start;
    while (index < masked.length && /\s/.test(masked[index] ?? "")) index += 1;
    return index;
  };
  const nearestBody = (start: number): number => {
    const index = nextCode(start);
    return masked[index] === "{" ? index : -1;
  };
  const declareVariable = (
    kind: string,
    pattern: string,
    position: number,
    rhs: string | undefined,
  ): void => {
    let scope = scopeAt(position);
    const before = masked.slice(Math.max(0, position - 24), position);
    const isForHeader = /\bfor\s*\([^)]*$/.test(before);
    if (isForHeader) {
      const close = getDelimiterMap(source).openingToClosing.get(masked.lastIndexOf("(", position));
      const body = close === undefined ? -1 : nearestBody(close + 1);
      if (body >= 0) scope = scopeAt(body + 1);
    }
    if (kind === "var") scope = nearestFunctionScope(scope);
    declarePattern(pattern, scope, position);
    if (rhs !== undefined) pending.push({ pattern, rhs, position, scope });
  };
  const readRhs = (start: number): string => {
    let depth = 0;
    for (let index = start; index < masked.length; index += 1) {
      const char = masked[index];
      if (depth === 0 && char === ")") return masked.slice(start, index).trim();
      if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && (char === ";" || char === "\n" || char === ",")) {
        return masked.slice(start, index).trim();
      }
    }
    return masked.slice(start).trim();
  };
  const declarationRe =
    /\b(const|let|var)\s+(\{[^}\n]{0,4096}\}|\[[^\]\n]{0,4096}\]|[A-Za-z_$][\w$]*)(?:\s*=\s*)?/g;
  for (const match of matchOutsideIgnored(source, declarationRe)) {
    if (match.index === undefined) continue;
    const after = match.index + match[0].length;
    const hasEquals = /=\s*$/.test(match[0]);
    let rhs: string | undefined;
    if (hasEquals) {
      rhs = readRhs(after);
    } else {
      const iteration = masked.slice(after).match(/^\s+(?:of|in)\s+/);
      if (iteration) rhs = readRhs(after + iteration[0].length);
    }
    declareVariable(match[1], match[2], match.index, rhs);
  }
  const declarationStatementRe = /\b(const|let|var)\s+([^;\n]+)/g;
  for (const match of matchOutsideIgnored(source, declarationStatementRe)) {
    if (match.index === undefined) continue;
    const parts = splitTopLevelExpressionList(match[2]);
    if (!parts || parts.length < 2) continue;
    let offset = match.index + match[0].indexOf(match[2]);
    for (const part of parts) {
      const equals = topLevelIndex(part, "=");
      if (equals < 0) {
        offset += part.length + 1;
        continue;
      }
      const pattern = part.slice(0, equals).trim();
      const rhs = part.slice(equals + 1).trim();
      declareVariable(match[1], pattern, offset + part.indexOf(pattern), rhs);
      offset += part.length + 1;
    }
  }

  for (const match of matchOutsideIgnored(source, /\b(?:class|function)\s+([A-Za-z_$][\w$]*)\b/g)) {
    if (match.index === undefined) continue;

    const before = masked.slice(0, match.index).trimEnd();
    const expressionName =
      /(?:=>|[=(:,{[!&|?+\-*\/%~])\s*$/.test(before) ||
      /\b(?:void|typeof|delete|new|return|throw|yield|await|instanceof|in|of|case)\s*$/.test(before);
    if (!expressionName) declareBinding(scopeAt(match.index), match[1], match.index);
    const body = masked.indexOf("{", match.index + match[0].length);
    if (body >= 0) declareBinding(scopeAt(body + 1), match[1], body);
  }
  const importRe =
    /\bimport\s+(?:\{([^}\n]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s+from\b/g;
  for (const match of matchOutsideIgnored(source, importRe)) {
    if (match.index === undefined) continue;
    const scope = scopeAt(match.index);
    if (match[1] !== undefined) {
      for (const entry of splitPattern(match[1])) {
        const name =
          entry.trim().match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/)?.[1] ??
          entry.trim().match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
        if (name) declareBinding(scope, name, match.index);
      }
    } else {
      declareBinding(scope, match[2] ?? match[3] ?? "", match.index);
    }
  }
  const parameterSpans: SourceSpan[] = [];
  const bindParameters = (
    raw: string,
    bodyStart: number,
    functionBoundary = true,
  ): void => {
    if (bodyStart < 0) return;
    const scope = scopeAt(bodyStart + 1);
    if (functionBoundary) scope.functionBoundary = true;
    for (const part of splitPattern(raw)) {
      for (const { name, values } of patternEntries(part)) {
        declareBinding(scope, name, bodyStart);
        if (values.size > 0) updateBinding(scope, name, bodyStart, values);
      }
    }
    for (const part of splitPattern(raw)) {
      const defaultAt = topLevelIndex(part, "=");
      if (defaultAt >= 0) {
        pending.push({
          pattern: part.slice(0, defaultAt),
          rhs: part.slice(defaultAt + 1),
          position: bodyStart,
          scope,
        });
      }
    }
  };
  for (const match of matchOutsideIgnored(
    source,
    /\bfunction(?:\s*\*)?(?:\s+[A-Za-z_$][\w$]*)?\s*\(/g,
  )) {
    if (match.index === undefined) continue;
    const opening = masked.indexOf("(", match.index + match[0].length - 1);
    const closing = getDelimiterMap(source).openingToClosing.get(opening) ?? -1;
    const body = closing < 0 ? -1 : nearestBody(closing + 1);
    if (body >= 0) parameterSpans.push({ start: opening + 1, end: closing });
    if (body >= 0) bindParameters(masked.slice(opening + 1, closing), body);
  }
  for (const match of matchOutsideIgnored(source, /\bcatch\s*\(/g)) {
    if (match.index === undefined) continue;
    const opening = masked.indexOf("(", match.index + match[0].length - 1);
    const closing = getDelimiterMap(source).openingToClosing.get(opening) ?? -1;
    const body = closing < 0 ? -1 : nearestBody(closing + 1);
    if (body >= 0) parameterSpans.push({ start: opening + 1, end: closing });
    if (body >= 0) bindParameters(masked.slice(opening + 1, closing), body, false);
  }
  const expressionEnd = (start: number): number => {
    const delimiters: string[] = [];
    for (let index = start; index < masked.length; index += 1) {
      const char = masked[index];
      if ("([{".includes(char)) delimiters.push(char);
      else if (")]}".includes(char)) {
        if (delimiters.length === 0) return index;
        delimiters.pop();
      } else if (delimiters.length === 0 && (char === ";" || char === ",")) {
        return index + 1;
      } else if (delimiters.length === 0 && (char === "\n" || char === "\r")) {
        let next = index + 1;
        while (next < masked.length && /\s/.test(masked[next] ?? "")) next += 1;
        let sourceNext = index + 1;
        while (sourceNext < source.text.length && /\s/.test(source.text[sourceNext] ?? "")) {
          sourceNext += 1;
        }
        let previous = index - 1;
        while (previous >= start && /\s/.test(masked[previous] ?? "")) previous -= 1;
        const previousChar = masked[previous] ?? "";
        const nextChar = masked[next] ?? "";
        const nextWordContinues =
          /^(?:instanceof|in|of)\b/.test(masked.slice(next));
        const nextStartsTemplate = source.text[sourceNext] === "`";
        if (
          !nextWordContinues &&
          !nextStartsTemplate &&
          !/[+\-*/%&|?:.<>=([{\[]/.test(previousChar) &&
          !/[+\-*/%&|?:.<>=([{\[]/.test(nextChar)
        ) {
          return index + 1;
        }
      }
    }
    return masked.length;
  };
  for (const match of matchOutsideIgnored(source, /=>/g)) {
    if (match.index === undefined) continue;
    let cursor = match.index - 1;
    while (cursor >= 0 && /\s/.test(masked[cursor] ?? "")) cursor -= 1;
    let raw = "";
    if (masked[cursor] === ")") {
      const opening = getDelimiterMap(source).closingToOpening.get(cursor) ?? -1;
      if (opening < 0) continue;
      parameterSpans.push({ start: opening + 1, end: cursor });
      raw = masked.slice(opening + 1, cursor);
    } else {
      const identifier = masked.slice(0, match.index).match(/[A-Za-z_$][\w$]*\s*$/);
      if (!identifier) continue;
      raw = identifier[0].trim();
    }
    const body = nextCode(match.index + 2);
    if (masked[body] === "{") {
      bindParameters(raw, body);
    } else {
      const expressionScope: ScannerBindingScope = {
        start: body,
        end: expressionEnd(body),
        parent: scopeAt(match.index),
        children: [],
        bindings: new Map(),
        functionBoundary: false,
        id: scopes.length + expressionScopes.length,
      };
      expressionScopes.push(expressionScope);
      for (const part of splitPattern(raw)) {
        for (const { name, values } of patternEntries(part)) {
          declareBinding(expressionScope, name, body);
          if (values.size > 0) updateBinding(expressionScope, name, body, values);
        }
      }
      for (const part of splitPattern(raw)) {
        const defaultAt = topLevelIndex(part, "=");
        if (defaultAt >= 0) {
          pending.push({
            pattern: part.slice(0, defaultAt),
            rhs: part.slice(defaultAt + 1),
            position: body,
            scope: expressionScope,
          });
        }
      }
    }
  }
  const controlHeaders = new Set(["if", "for", "while", "switch", "catch", "with"]);
  const methodRe =
    /(?:^|[;{},])\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+|\*\s*)?(#?[A-Za-z_$][\w$]*|\[[^\]]+\])\s*\(/g;
  for (const match of matchOutsideIgnored(source, methodRe)) {
    if (match.index === undefined || controlHeaders.has(match[1])) continue;
    const opening = masked.indexOf("(", match.index + match[0].length - 1);
    const closing = getDelimiterMap(source).openingToClosing.get(opening) ?? -1;
    const body = closing < 0 ? -1 : nearestBody(closing + 1);
    if (body >= 0) parameterSpans.push({ start: opening + 1, end: closing });
    if (body >= 0) bindParameters(masked.slice(opening + 1, closing), body);
  }

  const assignments: Array<{ name: string; rhs: string; position: number }> = [];
  const assignmentRe = /(?<![.\w$=!<>])([A-Za-z_$][\w$]*)\s*=\s*(?!=|>)/g;
  for (const match of matchOutsideIgnored(source, assignmentRe)) {
    if (match.index === undefined || isOverflowed(match.index)) continue;
    const declarationPrefix = masked.slice(Math.max(0, match.index - 12), match.index);
    if (/\b(?:const|let|var)\s*$/.test(declarationPrefix)) continue;
    assignments.push({
      name: match[1],
      rhs: readRhs(match.index + match[0].length),
      position: match.index,
    });
  }
  const destructuringAssignmentRe =
    /(?:^|[;,(])\s*(\{[^}\n]{1,4096}\}|\[[^\]\n]{1,4096}\])\s*=\s*(?!=|>)/g;
  for (const match of matchOutsideIgnored(source, destructuringAssignmentRe)) {
    if (match.index === undefined || isOverflowed(match.index)) continue;
    const scope = scopeAt(match.index);
    pending.push({
      pattern: match[1],
      rhs: readRhs(match.index + match[0].length),
      position: match.index,
      scope,
    });
  }
  const applyPending = (): boolean => {
    let changed = false;
    for (const item of pending) {
      const values = resolveExpression(item.rhs, item.position);
      for (const { name, values: next } of mapPatternValues(
        item.pattern,
        values,
        item.position,
      )) {
        const localBinding = item.scope.bindings.get(name);
        const found = localBinding
          ? { scope: item.scope, binding: localBinding }
          : findBinding(name, item.position);
        if (!found) continue;
        const before = valuesAt(found.binding, item.position);
        if (before.size !== next.size || [...before].some((value) => !next.has(value))) {
          updateBinding(found.scope, name, item.position, next);
          changed = true;
        }
      }
    }
    for (const assignment of assignments) {
      const found = findBinding(assignment.name, assignment.position);
      if (!found) continue;
      const next = resolveExpression(assignment.rhs, assignment.position);
      const before = valuesAt(found.binding, assignment.position);
      const assignmentScope = scopeAt(assignment.position);
      if (assignmentScope !== found.scope) {
        for (const value of before) next.add(value);
      }
      if (next.size !== before.size || [...before].some((value) => !next.has(value))) {
        const firstBindingPosition = found.binding.updates[0]?.position ?? assignment.position;
        const updatePosition = assignmentScope === found.scope
          ? assignment.position
          : Math.min(assignment.position, firstBindingPosition + 1);
        updateBinding(found.scope, assignment.name, updatePosition, next);
        changed = true;
      }
    }
    return changed;
  };
  let aliasConverged = false;
  for (let pass = 0; pass < 8; pass += 1) {
    if (!applyPending()) {
      aliasConverged = true;
      break;
    }
  }
  if (!aliasConverged) {
    overflowSpans.push({ start: 0, end: masked.length });
  }
  overflowSpans.sort((left, right) => left.start - right.start);
  expressionScopes.sort((left, right) => left.start - right.start);
  const lexical: ScannerLexicalContext = {
    root,
    scopes,
    scopeIds,
    overflowSpans,
    parameterSpans,
    resolveValues,
    resolveExpression,
    scopeAt,
    isOverflowed,
  };
  const checker: ScannerBindingChecker = (name: string, position: number): boolean =>
    findBinding(name, position) !== null;
  source.context.lexical = lexical;
  source.context.bindingChecker = checker;
  return checker;
}
function getScannerLexicalContext(source: ScannableSource): ScannerLexicalContext {
  if (!source.context.lexical) createScannerBindingChecker(source);
  return source.context.lexical as ScannerLexicalContext;
}

function scannerOriginHas(values: Set<ScannerOrigin>, origin: string): boolean {
  return values.has(origin) || [...values].some((value) => value.startsWith(`${origin}:`));
}

function scannerRootValues(
  source: ScannableSource,
  name: string,
  position: number,
): Set<ScannerOrigin> {
  return getScannerLexicalContext(source).resolveValues(name, position);
}

function scannerExpressionValues(
  source: ScannableSource,
  raw: string,
  position: number,
): Set<ScannerOrigin> {
  return getScannerLexicalContext(source).resolveExpression(raw, position);
}

function scannerIsLocal(source: ScannableSource, name: string, position: number): boolean {
  return source.context.bindingChecker?.(name, position) ?? false;
}

function scannerGlobalPropertyLabel(property: string | null): string | undefined {
  if (property === null) return DYNAMIC_GLOBAL_API_LABEL;
  return BLOCKED_GLOBAL_API_LABELS.get(property);
}

function scannerProcessPropertyLabel(property: string | null): string {
  return property === null || DANGEROUS_PROCESS_PROPERTIES.has(property)
    ? "dangerous process API usage"
    : "";
}

function scannerBunPropertyLabel(property: string | null): string {
  if (property === null) return "dangerous Bun system API usage";
  return DANGEROUS_BUN_PROPERTIES.get(property) ?? "";
}

function scannerModuleTarget(raw: string | undefined): string | null {
  return raw === undefined ? null : resolveStaticModuleSpecifier(raw);
}

function addModuleConstructorLoaderHits(
  source: ScannableSource,
  hits: Set<string>,
  dynamicLabel = "dynamic module access",
): void {
  if (
    !hasAnySourceToken(source, [
      "module",
      "globalThis",
      "self",
      "global",
      "Reflect",
      "Object",
      "require",
      "import",
      "createRequire",
    ])
  ) {
    return;
  }
  const lexical = getScannerLexicalContext(source);
  const addTarget = (raw: string | undefined, fromCreateRequire = false): void => {
    const resolved = scannerModuleTarget(raw);
    if (dynamicLabel === SERIALIZED_HANDLER_MODULE_LABEL) {
      hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
      return;
    }
    if (resolved === null) {
      hits.add(dynamicLabel);
      return;
    }
    if (fromCreateRequire && isNativeAddonModuleSpecifier(resolved)) hits.add(dynamicLabel);
    addModuleSpecifierHit(resolved, hits);
  };
  const addLoader = (values: Set<ScannerOrigin>, args: string[] | null): boolean => {
    const constructorLoader = [...values].some(
      (value) =>
        value === "module:constructor" ||
        value === "module:createRequire" ||
        value === "global:createRequire",
    );
    const loader = [...values].some(
      (value) =>
        value === "module:require" ||
        value === "global:require" ||
        value === "global:import",
    );
    const unknownModuleLoader = values.has("module:*");
    const unknownGlobalLoader = values.has("global:*");
    if (!loader && !constructorLoader && !unknownModuleLoader && !unknownGlobalLoader) return false;
    if ((unknownModuleLoader || unknownGlobalLoader) && !loader && !constructorLoader) {
      if (
        unknownModuleLoader ||
        dynamicLabel === SERIALIZED_HANDLER_MODULE_LABEL ||
        Boolean(args?.[0]?.trim())
      ) {
        hits.add(dynamicLabel);
      }
      return true;
    }
    if (constructorLoader) {
      hits.add(MODULE_CONSTRUCTOR_LOADER_LABEL);
      return true;
    }
    if (args === null || args[0] === undefined) hits.add(MODULE_CONSTRUCTOR_LOADER_LABEL);
    addTarget(args?.[0]);
    return true;
  };
  const dispatchLoader = (
    values: Set<ScannerOrigin>,
    mode: string | undefined,
    args: string[] | null,
    opening: number,
  ): void => {
    const addReturnedTarget = (): void => {
      const closing = getDelimiterMap(source).openingToClosing.get(opening) ?? -1;
      const nextOpen = closing < 0 ? -1 : source.text.indexOf("(", closing + 1);
      if (nextOpen >= 0 && /^\s*\(/.test(source.text.slice(closing + 1))) {
        addTarget(readCallArguments(source, nextOpen)?.[0], true);
      }
    };
    if (!mode) {
      if (addLoader(values, args)) addReturnedTarget();
      return;
    }
    const baseValues = values;
    let target: string | undefined;
    if (mode === "apply") {
      const applied = args?.[1]?.trim() ?? "";
      const valuesList =
        applied.startsWith("[") && applied.endsWith("]")
          ? splitTopLevelExpressionList(applied.slice(1, -1))
          : null;
      target = valuesList?.[0];
    } else {
      target = args?.[1];
    }
    if (addLoader(baseValues, target === undefined ? null : [target])) {
      addReturnedTarget();
    }
  };

  const callPattern =
    /(?<![\w$.])([A-Za-z_$][\w$]*(?:(?:\s*\??\.\s*[A-Za-z_$][\w$]*)|\s*\[[^\]]{0,300}\])*)\s*\(/g;
  for (const match of matchOutsideIgnored(source, callPattern)) {
    if (match.index === undefined) continue;
    const opening = match.index + match[0].lastIndexOf("(");
    const args = readCallArguments(source, opening);
    const rawPath = match[1];
    const compactPath = (stripModuleExpressionComments(rawPath) ?? rawPath).replace(/\s+/g, "");
    const modeMatch = compactPath.match(
      /(?:\.(call|apply|bind)|\[["'`](call|apply|bind)["'`]\])$/,
    );
    const mode = modeMatch?.[1] ?? modeMatch?.[2];
    const basePath = mode
      ? compactPath.replace(new RegExp(`(?:\\.${mode}|\\[["'\`]${mode}["'\`]\\])$`), "")
      : compactPath;
    let values = scannerExpressionValues(source, basePath, match.index);
    if (
      values.size === 0 &&
      basePath === "createRequire" &&
      !scannerIsLocal(source, "createRequire", match.index)
    ) {
      values = new Set(["module:createRequire"]);
    }
    if (basePath !== "import" && basePath !== "require") {
      dispatchLoader(values, mode, args, opening);
    } else if (mode) {
      dispatchLoader(values, mode, args, opening);
    }
    if (
      values.has("module:constructor") ||
      values.has("module:createRequire") ||
      values.has("global:require") ||
      values.has("global:import") ||
      values.has("global:createRequire")
    ) {
      hits.add(MODULE_CONSTRUCTOR_LOADER_LABEL);
    } else if (
      values.has("module:*") ||
      (values.has("global:*") && (
        dynamicLabel === SERIALIZED_HANDLER_MODULE_LABEL || Boolean(args?.[0]?.trim())
      ))
    ) {
      hits.add(dynamicLabel);
    }
  }

  const reflectApplyLoader =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*apply\s*\(/g;
  for (const match of matchOutsideIgnored(source, reflectApplyLoader)) {
    if (match.index === undefined) continue;
    const rootValues = scannerRootValues(source, match[1], match.index);
    if (!rootValues.has("reflect")) continue;
    const opening = source.text.indexOf("(", match.index + match[0].length - 1);
    const args = opening < 0 ? null : readCallArguments(source, opening);
    const applied = args?.[2]?.trim() ?? "";
    const list =
      applied.startsWith("[") && applied.endsWith("]")
        ? splitTopLevelExpressionList(applied.slice(1, -1))
        : null;
    if (!args || !list) continue;
    addLoader(scannerExpressionValues(source, args[0] ?? "", match.index), list);
  }

  const reflective = getDelimiterMap(source).openingToClosing;
  for (const call of parseReflectivePropertyCalls(source, source, reflective)) {
    if (call.method !== "get" && call.method !== "getOwnPropertyDescriptor") continue;
    const head = source.text.slice(call.position, call.opening).replace(/\s+/g, "");
    const root = head.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (!root) continue;
    const rootValues = scannerRootValues(source, root, call.position);
    if (!scannerOriginHas(rootValues, "reflect") && !scannerOriginHas(rootValues, "object")) continue;
    if (!call.args) continue;
    let receiver: string | undefined;
    let property: string | undefined;
    if (call.mode === "call") {
      receiver = call.args[1];
      property = call.args[2];
    } else if (call.mode === "apply") {
      const applied = call.args[1]?.trim() ?? "";
      const valuesList =
        applied.startsWith("[") && applied.endsWith("]")
          ? splitTopLevelExpressionList(applied.slice(1, -1))
          : null;
      receiver = valuesList?.[0];
      property = valuesList?.[1];
    } else if (call.mode === "bind") {
      receiver = call.args[1];
      property = call.args[2];
    } else {
      receiver = call.args[0];
      property = call.args[1];
    }
    const receiverValues = receiver
      ? scannerExpressionValues(source, receiver, call.position)
      : new Set<ScannerOrigin>();
    const resolvedProperty =
      property === undefined ? null : resolveStrictStaticStringExpression(property);
    const moduleValue = receiverValues.has("module");
    const globalValue = receiverValues.has("global");
    const tailClosing = reflective.get(call.opening) ?? -1;
    const tail = tailClosing < 0 ? "" : source.text.slice(tailClosing + 1);
    if (moduleValue) {
      if (
        resolvedProperty === "constructor" ||
        resolvedProperty === "require" ||
        resolvedProperty === "createRequire" ||
        resolvedProperty === "_load"
      ) {
        hits.add(MODULE_CONSTRUCTOR_LOADER_LABEL);
        const targetCall = tail.match(/^\s*(?:\.\s*value)?\s*\(/);
        if (targetCall) {
          const opening = tailClosing + 1 + targetCall[0].lastIndexOf("(");
          addTarget(readCallArguments(source, opening)?.[0]);
        }
      } else if (resolvedProperty === null) {
        hits.add(dynamicLabel);
      }
    } else if (globalValue) {
      if (resolvedProperty === null) {
        hits.add(dynamicLabel);
      } else if (
        resolvedProperty === "require" ||
        resolvedProperty === "import" ||
        resolvedProperty === "createRequire"
      ) {
        hits.add(MODULE_CONSTRUCTOR_LOADER_LABEL);
        const targetCall = tail.match(/^\s*(?:\.\s*value)?\s*\(/);
        if (targetCall) {
          const opening = tailClosing + 1 + targetCall[0].lastIndexOf("(");
          addTarget(readCallArguments(source, opening)?.[0]);
        }
      }
    }
  }

  const unresolvedReflective =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\[([^\]]{1,300})\]\s*\(/g;
  for (const match of matchOutsideIgnored(source, unresolvedReflective)) {
    if (match.index === undefined) continue;
    const roots = scannerRootValues(source, match[1], match.index);
    if (!roots.has("reflect") && !roots.has("object")) continue;
    const property = resolveStrictStaticStringExpression(match[2]);
    if (property === "get" || property === "getOwnPropertyDescriptor") continue;
    const opening = source.text.indexOf("(", match.index + match[0].length - 1);
    const args = opening < 0 ? null : readCallArguments(source, opening);
    if (!args) continue;
    const receiver = scannerExpressionValues(source, args[0] ?? "", match.index);
    if (receiver.has("module") || receiver.has("global")) hits.add(dynamicLabel);
  }

  if (lexical.overflowSpans.length > 0) {
    for (const span of lexical.overflowSpans) {
      if (
        source.text
          .slice(span.start, span.end)
          .match(/\b(?:module|globalThis|self|global|require)\b/)
      ) {
        hits.add(dynamicLabel);
      }
    }
  }
}

function addDynamicModuleHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasAnySourceToken(source, ["import", "require"])) return;
  const lexical = getScannerLexicalContext(source);
  for (const match of matchOutsideIgnored(source, BARE_MODULE_CALL_RE)) {
    if (match.index === undefined) continue;
    const tail = source.text.slice(match.index + match[0].length);
    if (/^\s*\{/.test(tail)) continue;
    const isImport = match[0].trimStart().startsWith("import");
    if (!isImport && scannerIsLocal(source, "require", match.index)) continue;
    const resolved = resolveStaticModuleSpecifier(match[1]);
    if (resolved === null) hits.add("dynamic module access");
    else addModuleSpecifierHit(resolved, hits);
  }
  const boundedStarts = new Set(
    matchOutsideIgnored(source, BARE_MODULE_CALL_RE)
      .map((match) => match.index)
      .filter((index): index is number => index !== undefined),
  );
  for (const prefix of matchOutsideIgnored(source, BARE_MODULE_CALL_PREFIX_RE)) {
    if (prefix.index !== undefined && !boundedStarts.has(prefix.index)) {
      if (
        !scannerIsLocal(source, "require", prefix.index) &&
        !lexical.isOverflowed(prefix.index)
      ) {
        hits.add("dynamic module access");
      }
    }
  }
}


const DYNAMIC_GLOBAL_API_LABEL = "dynamic global API access";
const GLOBAL_API_KEY_MAX_LENGTH = 300;
const GLOBAL_ALIAS_SCOPE_LIMIT = 4096;

function addGlobalApiHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasAnySourceToken(source, ["globalThis", "self", "global", "Reflect", "Object"])) return;
  const lexical = getScannerLexicalContext(source);
  const markGlobalProperty = (
    values: Set<ScannerOrigin>,
    property: string | null,
    position: number,
  ): void => {
    if (lexical.isOverflowed(position)) {
      hits.add(DYNAMIC_GLOBAL_API_LABEL);
      return;
    }
    if (!values.has("global")) return;
    const label = scannerGlobalPropertyLabel(property);
    if (label) hits.add(label);
    if (property === "module" || property === "require" || property === "import" || property === "createRequire") {
      hits.add(MODULE_CONSTRUCTOR_LOADER_LABEL);
    }
  };
  const dotAccess =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g;
  for (const match of matchOutsideIgnored(source, dotAccess)) {
    if (match.index === undefined) continue;
    markGlobalProperty(
      scannerRootValues(source, match[1], match.index),
      match[2],
      match.index,
    );
  }
  const computedAccess =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\[/g;
  const delimiters = getDelimiterMap(source);
  for (const match of matchOutsideIgnored(source, computedAccess)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    if (!values.has("global")) continue;
    const opening = source.text.indexOf("[", match.index + match[0].length - 1);
    const closing = delimiters.openingToClosing.get(opening) ?? -1;
    const keyExpression = opening < 0 || closing < 0
      ? null
      : source.text.slice(opening + 1, closing);
    const property = keyExpression === null || keyExpression.length > GLOBAL_API_KEY_MAX_LENGTH
      ? null
      : resolveStrictStaticStringExpression(keyExpression);
    markGlobalProperty(values, property, match.index);
  }
  const callPath =
    /(?<![\w$.])([A-Za-z_$][\w$]*(?:(?:\s*\??\.\s*[A-Za-z_$][\w$]*)|\s*\[[^\]]{0,300}\])*)\s*\(/g;
  for (const match of matchOutsideIgnored(source, callPath)) {
    if (match.index === undefined) continue;
    const values = scannerExpressionValues(source, match[1], match.index);
    for (const value of values) {
      if (!value.startsWith("global:")) continue;
      const property = value.slice("global:".length);
      markGlobalProperty(new Set(["global"]), property === "*" ? null : property, match.index);
    }
  }
  const destructuring =
    /(?:\b(?:const|let|var)\s*|\(\s*)\{([^}\n]{1,4096})\}\s*=\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of matchOutsideIgnored(source, destructuring)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[2], match.index);
    if (!values.has("global")) continue;
    for (const entry of splitTopLevelExpressionList(match[1]) ?? match[1].split(",")) {
      const colon = entry.indexOf(":");
      const rawKey = (colon < 0 ? entry : entry.slice(0, colon)).trim();
      const property = rawKey.startsWith("[")
        ? resolveStrictStaticStringExpression(rawKey.slice(1, -1))
        : rawKey.split(/\s*=/, 1)[0]?.trim() ?? "";
      markGlobalProperty(values, property || null, match.index);
    }
  }
  for (const call of parseReflectivePropertyCalls(source, source, delimiters.openingToClosing)) {
    if (call.method !== "get" && call.method !== "getOwnPropertyDescriptor") continue;
    const head = source.text.slice(call.position, call.opening).replace(/\s+/g, "");
    const root = head.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (!root || !call.args) continue;
    let callArgs = call.args;
    let callMode = call.mode;
    if (callMode === "bind" && callArgs.length < 3) {
      const closing = delimiters.openingToClosing.get(call.opening) ?? -1;
      const nextOpen = closing < 0 ? -1 : source.text.indexOf("(", closing + 1);
      if (nextOpen >= 0 && /^\s*\(/.test(source.text.slice(closing + 1))) {
        const deferredArgs = readCallArguments(source, nextOpen);
        if (deferredArgs) {
          callArgs = deferredArgs;
          callMode = undefined;
        }
      }
    }
    const rootValues = scannerRootValues(source, root, call.position);
    if (!scannerOriginHas(rootValues, "reflect") && !scannerOriginHas(rootValues, "object")) continue;
    let receiver: string | undefined;
    let property: string | undefined;
    if (callMode === "call") {
      receiver = callArgs[1];
      property = callArgs[2];
    } else if (callMode === "apply") {
      const applied = callArgs[1]?.trim() ?? "";
      const values =
        applied.startsWith("[") && applied.endsWith("]")
          ? splitTopLevelExpressionList(applied.slice(1, -1))
          : null;
      receiver = values?.[0];
      property = values?.[1];
    } else if (callMode === "bind") {
      receiver = callArgs[1];
      property = callArgs[2];
    } else {
      receiver = callArgs[0];
      property = callArgs[1];
    }
    const receiverValues = receiver
      ? scannerExpressionValues(source, receiver, call.position)
      : new Set<ScannerOrigin>();
    const resolvedProperty =
      property === undefined ? null : resolveStrictStaticStringExpression(property);
    if (receiverValues.has("global")) {
      markGlobalProperty(receiverValues, resolvedProperty, call.position);
    } else {
      const receiverName = receiver?.trim() ?? "";
      if (
        receiverValues.size === 0 &&
        /^[A-Za-z_$][\w$]*$/.test(receiverName) &&
        !scannerIsLocal(source, receiverName, call.position)
      ) {
        hits.add(DYNAMIC_GLOBAL_API_LABEL);
      }
    }
  }
  const reflectiveAliasCall =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of matchOutsideIgnored(source, reflectiveAliasCall)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    const method = [...values].find(
      (value) => value === "reflect:get" || value === "object:getOwnPropertyDescriptor",
    );
    if (!method) continue;
    const opening = source.text.indexOf("(", match.index + match[0].length - 1);
    const args = opening < 0 ? null : readCallArguments(source, opening);
    if (!args) continue;
    const receiverValues = scannerExpressionValues(source, args[0] ?? "", match.index);
    const property = resolveStrictStaticStringExpression(args[1] ?? "");
    if (receiverValues.has("global")) {
      markGlobalProperty(receiverValues, property, match.index);
    } else if (
      receiverValues.size === 0 &&
      /^[A-Za-z_$][\w$]*$/.test(args[0] ?? "") &&
      !scannerIsLocal(source, args[0] ?? "", match.index)
    ) {
      hits.add(DYNAMIC_GLOBAL_API_LABEL);
    }
  }

}

function addPropertyAccessHits(
  source: ScannableSource,
  objectName: string,
  propertyLabels: ReadonlyMap<string, string>,
  hits: Set<string>,
  unknownPropertyLabel?: string,
): void {
  if (!hasSourceToken(source, objectName)) return;
  const expected =
    objectName === "Bun"
      ? "bun"
      : objectName === "process"
        ? "process"
        : ["globalThis", "self", "global"].includes(objectName)
          ? "global"
          : objectName;
  const lexical = getScannerLexicalContext(source);
  const mark = (values: Set<ScannerOrigin>, property: string | null, position: number): void => {
    if (lexical.isOverflowed(position)) {
      const label = expected === "bun"
        ? "dangerous Bun system API usage"
        : expected === "process"
          ? "dangerous process API usage"
          : unknownPropertyLabel;
      if (label) hits.add(label);
      return;
    }
    const direct = values.has(expected);
    const aliased = [...values].some((value) => value.startsWith(`${expected}:`));
    if (!direct && !aliased) return;
    if (aliased) {
      for (const value of values) {
        if (!value.startsWith(`${expected}:`)) continue;
        const member = value.slice(expected.length + 1);
        const label = propertyLabels.get(member);
        if (label) hits.add(label);
      }
    }
    if (direct) {
      const label = property === null
        ? expected === "bun"
          ? "dangerous Bun system API usage"
          : expected === "process"
            ? "dangerous process API usage"
            : unknownPropertyLabel
        : propertyLabels.get(property);
      if (label) hits.add(label);
    }
  };
  const dotAccess =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g;
  for (const match of matchOutsideIgnored(source, dotAccess)) {
    if (match.index !== undefined) mark(
      scannerRootValues(source, match[1], match.index),
      match[2],
      match.index,
    );
  }
  const computedAccess =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\[/g;
  const delimiters = getDelimiterMap(source);
  for (const match of matchOutsideIgnored(source, computedAccess)) {
    if (match.index === undefined) continue;
    const opening = source.text.indexOf("[", match.index + match[0].length - 1);
    const closing = delimiters.openingToClosing.get(opening) ?? -1;
    const property =
      opening < 0 || closing < 0
        ? null
        : resolveStrictStaticStringExpression(source.text.slice(opening + 1, closing));
    mark(scannerRootValues(source, match[1], match.index), property, match.index);
  }
  const memberValueCall =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(/g;
  for (const match of matchOutsideIgnored(source, memberValueCall)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    for (const value of values) {
      if (!value.startsWith(`${expected}:`)) continue;
      const member = value.slice(expected.length + 1);
      const label = propertyLabels.get(member);
      if (label) hits.add(label);
    }
  }
}
function addReflectiveProcessPropertyHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasAnySourceToken(source, ["process", "Reflect", "Object"])) return;
  const lexical = getScannerLexicalContext(source);
  const markProcess = (
    receiver: string | undefined,
    property: string | undefined,
    position: number,
  ): void => {
    const values = receiver
      ? scannerExpressionValues(source, receiver, position)
      : new Set<ScannerOrigin>();
    if (lexical.isOverflowed(position)) {
      if (values.has("process") || [...values].some((value) => value.startsWith("process:"))) {
        hits.add("dangerous process API usage");
      }
      return;
    }
    const direct = values.has("process");
    const aliases = [...values].filter((value) => value.startsWith("process:"));
    if (!direct && aliases.length === 0) return;
    if (aliases.length > 0) {
      hits.add("dangerous process API usage");
      return;
    }
    const resolved =
      property === undefined ? null : resolveStrictStaticStringExpression(property);
    const label = scannerProcessPropertyLabel(resolved);
    if (label) hits.add(label);
  };
  const delimiters = getDelimiterMap(source);
  for (const call of parseReflectivePropertyCalls(source, source, delimiters.openingToClosing)) {
    if (call.method !== "get" && call.method !== "getOwnPropertyDescriptor") continue;
    if (!call.args) continue;
    const head = source.text.slice(call.position, call.opening).replace(/\s+/g, "");
    const root = head.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (!root) continue;
    const rootValues = scannerRootValues(source, root, call.position);
    if (!scannerOriginHas(rootValues, "reflect") && !scannerOriginHas(rootValues, "object")) continue;
    let receiver: string | undefined;
    let property: string | undefined;
    if (call.mode === "call") {
      receiver = call.args[1];
      property = call.args[2];
    } else if (call.mode === "apply") {
      const applied = call.args[1]?.trim() ?? "";
      const values =
        applied.startsWith("[") && applied.endsWith("]")
          ? splitTopLevelExpressionList(applied.slice(1, -1))
          : null;
      receiver = values?.[0];
      property = values?.[1];
    } else if (call.mode === "bind") {
      receiver = call.args[1];
      property = call.args[2];
    } else {
      receiver = call.args[0];
      property = call.args[1];
    }
    markProcess(receiver, property, call.position);
  }
  const reflectApply =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*apply\s*\(/g;
  for (const match of matchOutsideIgnored(source, reflectApply)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    if (!scannerOriginHas(values, "reflect")) continue;
    const opening = source.text.indexOf("(", match.index + match[0].length - 1);
    const args = opening < 0 ? null : readCallArguments(source, opening);
    if (!args) continue;
    const target = (stripModuleExpressionComments(args[0]) ?? args[0]).replace(/\s+/g, "");
    if (!/(?:^|\.)(?:get|getOwnPropertyDescriptor)$/.test(target)) continue;
    const applied = args[2]?.trim() ?? "";
    const valuesList =
      applied.startsWith("[") && applied.endsWith("]")
        ? splitTopLevelExpressionList(applied.slice(1, -1))
        : null;
    if (valuesList) markProcess(valuesList[0], valuesList[1], match.index);
  }
  const reflectiveAliasCall =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of matchOutsideIgnored(source, reflectiveAliasCall)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    const method = [...values].find(
      (value) => value === "reflect:get" || value === "object:getOwnPropertyDescriptor",
    );
    if (!method) continue;
    const opening = source.text.indexOf("(", match.index + match[0].length - 1);
    const args = opening < 0 ? null : readCallArguments(source, opening);
    if (!args) continue;
    markProcess(args[0], args[1], match.index);
  }

}

function splitTopLevelExpressionList(raw: string): string[] | null {
  const spans = collectIgnoredSpans(raw);
  const parts: string[] = [];
  let start = 0;
  const stack: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (isIgnoredIndex(index, spans)) {
      const span = ignoredSpanAt(index, spans);
      if (span) index = span.end - 1;
      continue;
    }
    const char = raw[index];
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack.pop() !== expected) return null;
      continue;
    }
    if (char === "," && stack.length === 0) {
      parts.push(raw.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (stack.length > 0) return null;
  parts.push(raw.slice(start).trim());
  return parts;
}

function readCallArguments(source: ScannableSource, opening: number): string[] | null {
  const parts: string[] = [];
  const stack: string[] = ["("];
  let start = opening + 1;
  for (let index = opening + 1; index < source.text.length; index += 1) {
    if (isIgnoredIndex(index, source.ignoredSpans)) {
      const span = ignoredSpanAt(index, source.ignoredSpans);
      if (span) index = span.end - 1;
      continue;
    }
    const char = source.text[index];
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) {
        parts.push(source.text.slice(start, index).trim());
        return parts;
      }
      continue;
    }
    if (char === "," && stack.length === 1) {
      parts.push(source.text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return null;
}
type ReflectivePropertyCall = {
  method: string | null;
  mode: "call" | "apply" | "bind" | "unknown" | undefined,
  args: string[] | null;
  position: number;
  opening: number;
};

function buildDelimiterMap(source: ScannableSource): ScannerDelimiterMap {
  const openingToClosing = new Map<number, number>();
  const closingToOpening = new Map<number, number>();
  const stack: Array<{ opener: string; index: number }> = [];
  const closingFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < source.text.length; index += 1) {
    if (isIgnoredIndex(index, source.ignoredSpans)) continue;
    const char = source.text[index];
    if (char === "(" || char === "[" || char === "{") {
      stack.push({ opener: char, index });
    } else if (char === ")" || char === "]" || char === "}") {
      const top = stack[stack.length - 1];
      if (top?.opener === closingFor[char]) {
        stack.pop();
        openingToClosing.set(top.index, index);
        closingToOpening.set(index, top.index);
      }
    }
  }
  return { openingToClosing, closingToOpening };
}

function parseReflectivePropertyCalls(
  source: ScannableSource,
  originalSource: ScannableSource,
  openingToClosing: ReadonlyMap<number, number>,
): ReflectivePropertyCall[] {
  const calls: ReflectivePropertyCall[] = [];
  const reflectiveRoots = new Set(["Reflect", "Object"]);
  const aliasDeclaration = new RegExp(
    `\\b(?:const|let|var)${MODULE_COMMENT_GAP}([A-Za-z_$][\\w$]*)${MODULE_COMMENT_GAP}=${MODULE_COMMENT_GAP}([A-Za-z_$][\\w$]*)\\b`,
    "g",
  );
  for (let pass = 0; pass < 8; pass += 1) {
    const before = reflectiveRoots.size;
    for (const alias of matchOutsideIgnored(source, aliasDeclaration)) {
      if (reflectiveRoots.has(alias[2])) reflectiveRoots.add(alias[1]);
    }
    if (reflectiveRoots.size === before) break;
  }
  const escapedRoots = [...reflectiveRoots]
    .sort((left, right) => right.length - left.length)
    .map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const reflectedMethod = new RegExp(
    `\\b(?:${escapedRoots})${MODULE_COMMENT_GAP}(?:\\.${MODULE_COMMENT_GAP}(get|getOwnPropertyDescriptor)|\\[\\s*([^\\]]{0,300})\\s*\\])${MODULE_COMMENT_GAP}(?:(?:\\.${MODULE_COMMENT_GAP}(call|apply|bind))|(?:\\[\\s*([^\\]]{0,300})\\s*\\]))?\\(`,
    "g",
  );
  for (const match of matchOutsideIgnored(source, reflectedMethod)) {
    if (match.index === undefined) continue;
    const matchIndex = match.index;
    const computedBrackets: number[] = [];
    for (let offset = 0; offset < match[0].length; offset += 1) {
      if (match[0][offset] === "[") computedBrackets.push(matchIndex + offset);
    }
    const resolveComputedKey = (bracket: number | undefined): string | null => {
      if (bracket === undefined) return null;
      const closing = openingToClosing.get(bracket) ?? -1;
      return closing < 0
        ? null
        : resolveStrictStaticStringExpression(
            originalSource.text.slice(bracket + 1, closing),
          );
    };
    const method =
      match[1] ?? resolveComputedKey(computedBrackets[0]);
    const modeKey =
      match[3] ??
      (match[4] !== undefined
        ? resolveComputedKey(match[2] !== undefined ? computedBrackets[1] : computedBrackets[0])
        : null);
    const hasModeSuffix = match[3] !== undefined || match[4] !== undefined;
    const mode =
      modeKey === "call" || modeKey === "apply" || modeKey === "bind"
        ? modeKey
        : hasModeSuffix
          ? "unknown"
          : undefined;
    const opening = matchIndex + match[0].length - 1;
    if (!openingToClosing.has(opening)) continue;
    let args = readCallArguments(originalSource, opening);
    if (mode === "bind" && (args?.length ?? 0) < 3) {
      const closing = openingToClosing.get(opening) ?? -1;
      const masked = getMaskedSource(originalSource);
      let invocation = closing + 1;
      while (invocation < masked.length && /\s/.test(masked[invocation] ?? "")) invocation += 1;
      if (masked[invocation] === "(" && openingToClosing.has(invocation)) {
        args = [args?.[0] ?? "", ...(readCallArguments(originalSource, invocation) ?? [])];
      }
    }
    calls.push({
      method,
      mode,
      args,
      position: matchIndex,
      opening,
    });
  }
  return calls;
}



function addSerializedModuleDestructuringHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasAnySourceToken(source, ["globalThis", "self", "global"])) return;
  const destructuring =
    /\b(?:const|let|var)\s*\{([^}\n]{1,4096})\}\s*=\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of matchOutsideIgnored(source, destructuring)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[2], match.index);
    if (!values.has("global")) continue;
    for (const entry of splitTopLevelExpressionList(match[1]) ?? match[1].split(",")) {
      const colon = entry.indexOf(":");
      const rawKey = (colon < 0 ? entry : entry.slice(0, colon)).trim();
      const keyExpression = rawKey.split(/\s*=/, 1)[0]?.trim() ?? "";
      const property = keyExpression.startsWith("[")
        ? resolveStrictStaticStringExpression(keyExpression.slice(1, -1))
        : keyExpression;
      if (property === null || property === "require" || property === "import") {
        hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
      }
    }
  }
}

function addSerializedComputedModuleAccessHits(source: ScannableSource, hits: Set<string>): void {
  if (!hasAnySourceToken(source, ["globalThis", "self", "global"])) return;
  const computedAccess =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\[/g;
  const delimiters = getDelimiterMap(source);
  for (const match of matchOutsideIgnored(source, computedAccess)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    if (!values.has("global")) continue;
    const opening = source.text.indexOf("[", match.index + match[0].length - 1);
    const closing = delimiters.openingToClosing.get(opening) ?? -1;
    const property =
      opening < 0 || closing < 0
        ? null
        : resolveStrictStaticStringExpression(source.text.slice(opening + 1, closing));
    if (property === null || property === "require" || property === "import") {
      hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
    }
  }
}

/**
 * Maps a scanner label to the manifest-declared capability that, when
 * present, suppresses that label. Capabilities are install-time opt-ins
 * declared in `spindle.json`'s `requested_capabilities` field; the user
 * grants them on install just like `permissions`. Only labels with a
 * meaningful false-positive rate get a capability mapping — filesystem,
 * subprocess, sockets, sqlite, workers, module loaders, native FFI loaders,
 * direct network/filesystem/subprocess/sensitive/worker runtime APIs, Bun
 * system APIs, and process APIs remain hard-blocked with no opt-in available.
 */
const LABEL_TO_CAPABILITY: ReadonlyMap<string, SpindleCapability> = new Map([
  ["dynamic code execution", "dynamic_code_execution"],
  ["base64 decoding",        "base64_decode"],
]);

/**
 * Match `Function(...)` calls where the FIRST argument is an empty string
 * literal (or where the call has no arguments). Used to carve out the
 * Zod / generic feature-detect probe `try { new Function(""); … }` that
 * checks for Cloudflare-Workers-style environments without actually
 * executing any code. The body of an empty-string Function is empty —
 * the call constructs a no-op, indistinguishable from `() => {}`.
 *
 * Matches `Function()`, `Function("")`, `Function('')`, `Function(\`\`)`,
 * with whitespace tolerated.
 */
const EMPTY_FUNCTION_PROBE_RE = /\bFunction\s*\(\s*(?:""|''|``|)\s*\)/g;

const SERIALIZED_HANDLER_MODULE_LABEL = "module loading";
const SERIALIZED_MODULE_PROPERTY_LABELS: ReadonlyMap<string, string> = new Map([
  ["require", SERIALIZED_HANDLER_MODULE_LABEL],
  ["import", SERIALIZED_HANDLER_MODULE_LABEL],
  ["createRequire", SERIALIZED_HANDLER_MODULE_LABEL],
]);
const SERIALIZED_GLOBAL_MODULE_OBJECTS = ["globalThis", "self", "global"] as const;
const SERIALIZED_SCANNER_HINTS = [
  "module",
  "globalThis",
  "self",
  "global",
  "require",
  "import",
  "createRequire",
  "Reflect",
  "Object",
  "constructor",
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
] as const;

/**
 * Serialized macro handlers execute inside a worker but are not extension
 * bundles: they have no module-loading contract at all. Keep this check
 * independent from the install-time dangerous-module map so package-local
 * imports, `data:`/`file:` URLs, and loader aliases cannot become a handler
 * capability by omission or manifest opt-in.
 */
export function detectSerializedHandlerModuleAccess(content: string): string[] {
  const hits = new Set<string>();
  for (const source of createScannableSources(content)) {
    if (!SERIALIZED_SCANNER_HINTS.some((token) => source.text.includes(token))) continue;
    const lexical = getScannerLexicalContext(source);
    addModuleConstructorLoaderHits(source, hits, SERIALIZED_HANDLER_MODULE_LABEL);
    addDynamicCodeExecutionHits(source, hits, { ignoreEmptyFunctionProbe: false });
    if (matchOutsideIgnored(source, STATIC_MODULE_IMPORT_RE).length > 0) {
      hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
    }
    for (const match of matchOutsideIgnored(source, BARE_MODULE_CALL_RE)) {
      if (match.index === undefined) continue;
      const isImport = match[0].trimStart().startsWith("import");
      if (isImport || !scannerIsLocal(source, "require", match.index)) {
        hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
      }
    }
    const unresolvedImportCall = new RegExp(
      `(?<![\\w$.])import${MODULE_COMMENT_GAP}\\(`,
      "g",
    );
    if (matchOutsideIgnored(source, unresolvedImportCall).length > 0) {
      hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
    }

    const requireReference = new RegExp(
      `(?<![\\w$])require${MODULE_COMMENT_GAP}(?!:)`,
      "g",
    );
    for (const match of matchOutsideIgnored(source, requireReference)) {
      if (
        match.index !== undefined &&
        !lexical.parameterSpans.some(
          (span) => match.index !== undefined && match.index >= span.start && match.index < span.end,
        ) &&
        !scannerIsLocal(source, "require", match.index)
      ) {
        hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
      }
    }
    for (const objectName of SERIALIZED_GLOBAL_MODULE_OBJECTS) {
      addPropertyAccessHits(
        source,
        objectName,
        SERIALIZED_MODULE_PROPERTY_LABELS,
        hits,
        SERIALIZED_HANDLER_MODULE_LABEL,
      );
    }
    addSerializedComputedModuleAccessHits(source, hits);
    addSerializedModuleDestructuringHits(source, hits);
    const requireMeta = new RegExp(
      `\\brequire${MODULE_COMMENT_GAP}(?:\\.|\\[)\\s*(?:main|cache)`,
      "g",
    );
    if (
      matchOutsideIgnored(source, requireMeta).some(
        (match) => match.index !== undefined && !scannerIsLocal(source, "require", match.index),
      )
    ) {
      hits.add(SERIALIZED_HANDLER_MODULE_LABEL);
    }
  }
  return [...hits];
}

function isEmptyFunctionProbe(source: ScannableSource, matchIndex: number): boolean {
  EMPTY_FUNCTION_PROBE_RE.lastIndex = 0;
  let probe: RegExpExecArray | null;
  while ((probe = EMPTY_FUNCTION_PROBE_RE.exec(source.text)) !== null) {
    // matchIndex points at the `F` of `Function(`; the probe match also
    // starts at the `F` after `\b`. So index equality is the test.
    if (probe.index === matchIndex) return true;
    if (probe.index > matchIndex) return false;
  }
  return false;
}
function addDynamicCodeExecutionHits(
  source: ScannableSource,
  hits: Set<string>,
  options: { ignoreEmptyFunctionProbe: boolean },
): void {
  if (
    !hasAnySourceToken(source, [
      "eval",
      "Function",
      "AsyncFunction",
      "GeneratorFunction",
      "constructor",
      "Reflect",
      "globalThis",
      "self",
      "global",
      "[",
    ])
  ) {
    return;
  }
  const lexical = getScannerLexicalContext(source);
  const dynamicOrigins = new Set([
    "eval",
    "function",
    "asyncFunction",
    "generatorFunction",
    "asyncGeneratorFunction",
  ]);
  const callPath =
    /(?<![\w$.])([A-Za-z_$][\w$]*(?:(?:\s*\??\.\s*[A-Za-z_$][\w$]*)|\s*\[[^\]]{0,300}\])*)\s*\(/g;
  for (const match of matchOutsideIgnored(source, callPath)) {
    if (match.index === undefined) continue;
    const values = scannerExpressionValues(source, match[1], match.index);
    let dangerous = false;
    for (const value of values) {
      if (dynamicOrigins.has(value) || value === "global:Function" || value === "global:eval") {
        dangerous = true;
        break;
      }
    }
    const directFunction = /(?:^|[.\]])Function$/.test(match[1].replace(/\s+/g, ""));
    if (
      dangerous &&
      options.ignoreEmptyFunctionProbe &&
      directFunction &&
      isEmptyFunctionProbe(source, match.index + match[1].lastIndexOf("Function"))
    ) {
      dangerous = false;
    }
    if (dangerous) {
      hits.add("dynamic code execution");
      break;
    }
  }
  const globalProperties =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g;
  for (const match of matchOutsideIgnored(source, globalProperties)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    if (!values.has("global")) continue;
    if (dynamicOrigins.has(match[2]) && !options.ignoreEmptyFunctionProbe) {
      hits.add("dynamic code execution");
      break;
    }
  }
  const computedProperties =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\[/g;
  const delimiters = getDelimiterMap(source);
  for (const match of matchOutsideIgnored(source, computedProperties)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    if (!values.has("global")) continue;
    const opening = source.text.indexOf("[", match.index + match[0].length - 1);
    const closing = delimiters.openingToClosing.get(opening) ?? -1;
    const property =
      opening < 0 || closing < 0
        ? null
        : resolveStrictStaticStringExpression(source.text.slice(opening + 1, closing));
    if (property !== null && dynamicOrigins.has(property)) {
      hits.add("dynamic code execution");
      break;
    }
  }
  const computedConstructorCall = new RegExp(
    `\\[\\s*([^\\]]{1,${GLOBAL_API_KEY_MAX_LENGTH}})\\s*\\]\\s*(?:\\?\\.\\s*)?(?:\\.\\s*(?:call|apply|bind)\\s*)?\\(`,
    "g",
  );
  if (
    matchOutsideIgnored(source, computedConstructorCall).some(
      (match) => resolveStrictStaticStringExpression(match[1]) === "constructor",
    )
  ) {
    hits.add("dynamic code execution");
  }
  const memberConstructorCall =
    /\.\s*constructor\b\s*(?:(?:\?\.\s*)?\(|(?:\?\.|\.)\s*(?:call|apply|bind)\s*\(|(?:\?\.\s*)?\[\s*["'`](?:call|apply|bind)["'`]\s*\]\s*\()/g;
  if (matchOutsideIgnored(source, memberConstructorCall).length > 0) {
    hits.add("dynamic code execution");
  }
  const reflectiveConstructorCall =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*(construct|apply)\s*\(/g;
  const isDynamicConstructorTarget = (target: string, position: number): boolean => {
    const spans = collectIgnoredSpans(target);
    const constructorReference = /(?:^|[.?])constructor\b/g;
    if (
      matchOutsideIgnored({ ...source, text: target, ignoredSpans: spans }, constructorReference)
        .length > 0
    ) {
      return true;
    }
    return [...scannerExpressionValues(source, target, position)].some(
      (value) =>
        dynamicOrigins.has(value) ||
        value === "global:Function" ||
        value === "global:eval",
    );
  };
  for (const match of matchOutsideIgnored(source, reflectiveConstructorCall)) {
    if (match.index === undefined) continue;
    const values = scannerRootValues(source, match[1], match.index);
    if (!values.has("reflect")) continue;
    const opening = source.text.indexOf("(", match.index + match[0].length - 1);
    const args = opening < 0 ? null : readCallArguments(source, opening);
    if (!args || !isDynamicConstructorTarget(args[0] ?? "", match.index)) continue;
    hits.add("dynamic code execution");
    break;
  }

  if (lexical.overflowSpans.length > 0) {
    hits.add("dynamic code execution");
  }
}

export function detectDangerousBackendCapabilities(
  content: string,
  declared: ReadonlySet<SpindleCapability> = new Set(),
): string[] {
  const hits = new Set<string>();
  for (const source of createScannableSources(content)) {
    addStaticModuleHits(source, hits);
    addReachableModuleRequireHits(source, hits);
    addModuleConstructorLoaderHits(source, hits);
    addDynamicModuleHits(source, hits);
    addImportMetaRequireHits(source, hits);
    addGlobalApiHits(source, hits);
    addPropertyAccessHits(source, "Bun", DANGEROUS_BUN_PROPERTIES, hits);
    addPropertyAccessHits(source, "process", DANGEROUS_PROCESS_PROPERTIES, hits);
    addReflectiveProcessPropertyHits(source, hits);

    addDynamicCodeExecutionHits(source, hits, { ignoreEmptyFunctionProbe: true });

    // Base64 decoding — `Buffer.from(..., "base64")`. Split from
    // dynamic-execution so it carries its own capability and can be
    // declared independently.
    if (matchOutsideIgnored(source, /\bBuffer\.from\s*\([^)]*["'`]base64["'`]/).length > 0) {
      hits.add("base64 decoding");
    }
  }

  if (declared.size === 0) return [...hits];
  return [...hits].filter((label) => {
    const cap = LABEL_TO_CAPABILITY.get(label);
    return cap === undefined || !declared.has(cap);
  });
}

/**
 * Normalize a manifest's `requested_capabilities` field into a Set the
 * scanner can consume. Invalid entries are dropped silently — the scanner
 * still enforces the underlying check; an invalid declaration just means
 * no opt-in.
 */
export function declaredCapabilitiesFromManifest(
  manifest: SpindleManifest,
): Set<SpindleCapability> {
  const declared = new Set<SpindleCapability>();
  const raw = manifest.requested_capabilities;
  if (!Array.isArray(raw)) return declared;
  for (const entry of raw) {
    if (typeof entry === "string" && isValidCapability(entry)) declared.add(entry);
  }
  return declared;
}

const BACKEND_MODULE_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".ts", ".tsx"] as const;

function isRelativeBackendModuleSpecifier(specifier: string): boolean {
  return /^(?:\.{1,2})(?:[\\/]|$)/.test(specifier);
}

function resolveBackendModuleDependency(
  repo: string,
  importer: string,
  rawSpecifier: string,
): string | null {
  const specifier = rawSpecifier.trim().replace(/\\/g, "/");
  if (!isRelativeBackendModuleSpecifier(specifier)) {
    if (/^(?:[A-Za-z]:|\/)/.test(specifier)) {
      throw new Error(`Backend module escapes extension repo: ${rawSpecifier}`);
    }
    throw new Error(
      `External backend module "${rawSpecifier}" must be bundled into the extension`,
    );
  }
  if (specifier.includes("\0") || /[?#]/.test(specifier)) {
    throw new Error(`Unsupported local backend module specifier "${rawSpecifier}"`);
  }

  const candidate = resolve(dirname(importer), specifier);
  const attempts = [candidate];
  if (!extname(candidate)) {
    for (const extension of BACKEND_MODULE_EXTENSIONS) {
      attempts.push(`${candidate}${extension}`);
    }
  }

  for (const attempt of attempts) {
    const checked = resolveWithin(repo, attempt, "backend module dependency");
    let entryStat: Stats;
    try {
      entryStat = lstatSync(checked);
    } catch {
      continue;
    }
    if (entryStat.isFile()) {
      const fileExtension = extname(checked).toLowerCase();
      if (
        fileExtension &&
        !BACKEND_MODULE_EXTENSIONS.some((extension) => extension === fileExtension)
      ) {
        throw new Error(`Unsupported local backend module "${rawSpecifier}"`);
      }
      return checked;
    }
    if (!entryStat.isDirectory()) continue;
    for (const extension of BACKEND_MODULE_EXTENSIONS) {
      const indexPath = resolveWithin(repo, join(checked, `index${extension}`), "backend module dependency");
      try {
        const indexStat = lstatSync(indexPath);
        if (indexStat.isFile()) return indexPath;
      } catch {
        // Keep looking through the supported index extensions.
      }
    }
  }
  throw new Error(`Unresolved local backend module "${rawSpecifier}" imported by ${importer}`);
}

function collectBackendModuleSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const source of createScannableSources(content)) {
    for (const match of matchOutsideIgnored(source, STATIC_MODULE_IMPORT_RE)) {
      const specifier = decodeQuotedLiteral(match[1]);
      if (specifier === null) {
        throw new Error("Unable to decode a static backend module specifier");
      }
      specifiers.add(specifier);
    }

    for (const match of matchOutsideIgnored(source, BARE_MODULE_CALL_RE)) {
      if (match.index === undefined) continue;
      const tail = source.text.slice(match.index + match[0].length);
      if (/^\s*\{/.test(tail)) continue;
      const isImport = match[0].trimStart().startsWith("import");
      if (!isImport && scannerIsLocal(source, "require", match.index)) continue;
      const specifier = resolveStaticModuleSpecifier(match[1]);
      if (specifier === null) {
        throw new Error("Unable to resolve a dynamic backend module specifier");
      }
      specifiers.add(specifier);
    }

    const metaRequire = new RegExp(
      `\\bimport${MODULE_COMMENT_GAP}\\.${MODULE_COMMENT_GAP}meta${MODULE_COMMENT_GAP}\\.${MODULE_COMMENT_GAP}require${MODULE_COMMENT_GAP}\\(`,
      "g",
    );
    for (const match of matchOutsideIgnored(source, metaRequire)) {
      if (match.index === undefined) continue;
      const opening = source.text.indexOf("(", match.index + match[0].length - 1);
      const args = opening < 0 ? null : readCallArguments(source, opening);
      const specifier = resolveStaticModuleSpecifier(args?.[0] ?? "");
      if (specifier === null) {
        throw new Error("Unable to resolve a dynamic backend module specifier");
      }
      specifiers.add(specifier);
    }

    const callPath =
      /(?<![\w$.])([A-Za-z_$][\w$]*(?:(?:\s*\??\.\s*[A-Za-z_$][\w$]*)|\s*\[[^\]]{0,300}\])*)\s*\(/g;
    for (const match of matchOutsideIgnored(source, callPath)) {
      if (match.index === undefined) continue;
      const compactPath = (stripModuleExpressionComments(match[1]) ?? match[1]).replace(/\s+/g, "");
      if (compactPath === "import" || compactPath === "require") continue;
      const modeMatch = compactPath.match(
        /(?:\.(call|apply|bind)|\[["'`](call|apply|bind)["'`]\])$/,
      );
      const mode = modeMatch?.[1] ?? modeMatch?.[2];
      const basePath = mode
        ? compactPath.replace(new RegExp(`(?:\\.${mode}|\\[["'\`]${mode}["'\`\\]])$`), "")
        : compactPath;
      const values = scannerExpressionValues(source, basePath, match.index);
      const loader = [...values].some(
        (value) =>
          value === "module:require" ||
          value.startsWith("module:require:") ||
          value === "global:require" ||
          value === "global:import",
      );
      if (!loader) continue;
      const opening = match.index + match[0].lastIndexOf("(");
      const args = readCallArguments(source, opening);
      const specifier = resolveStaticModuleSpecifier(args?.[0] ?? "");
      if (specifier === null) {
        throw new Error("Unable to resolve a dynamic backend module specifier");
      }
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

export async function validateBackendModuleGraph(
  identifier: string,
  entryPath: string,
  declared: ReadonlySet<SpindleCapability> = new Set(),
): Promise<string> {
  const repo = trustedRepoDir(identifier, "backend repository");
  const canonicalEntry = resolveWithin(repo, entryPath, "entry_backend");
  if (!(await Bun.file(canonicalEntry).exists())) {
    throw new Error(`Backend entry not found for extension "${identifier}"`);
  }

  const pending = [canonicalEntry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    let currentStat: Stats;
    const currentExtension = extname(current).toLowerCase();
    if (
      currentExtension &&
      !BACKEND_MODULE_EXTENSIONS.some((extension) => extension === currentExtension)
    ) {
      throw new Error(`Unsupported backend module: ${current}`);
    }
    try {
      currentStat = lstatSync(current);
    } catch {
      throw new Error(`Backend module disappeared during validation: ${current}`);
    }
    if (!currentStat.isFile()) {
      throw new Error(`Backend module is not a regular file: ${current}`);
    }

    const content = await Bun.file(current).text();
    const blocked = detectDangerousBackendCapabilities(content, declared);
    if (blocked.length > 0) {
      throw new Error(
        `Extension "${identifier}" uses blocked backend capabilities: ${blocked.join(", ")}`,
      );
    }
    for (const specifier of collectBackendModuleSpecifiers(content)) {
      const dependency = resolveBackendModuleDependency(repo, current, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return canonicalEntry;
}

async function assertSafeBackendBundle(
  identifier: string,
  backendPath: string,
  declared: ReadonlySet<SpindleCapability> = new Set(),
): Promise<void> {
  if (!(await Bun.file(backendPath).exists())) return;
  await validateBackendModuleGraph(identifier, backendPath, declared);
}

/**
 * Parse a stored JSON array column safely. A corrupted `permissions` row used
 * to crash extension load/sync; treat the row as having no permissions instead
 * so the rest of the extensions can still be served.
 */
function parsePermissionsSafe<T = string>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    console.error("[Spindle] Corrupted permissions JSON; treating as empty");
    return [];
  }
}

// ─── Paths ───────────────────────────────────────────────────────────────

function extensionsDir(): string {
  return join(env.dataDir, "extensions");
}

function extensionDir(identifier: string): string {
  return join(extensionsDir(), identifier);
}

function repoDir(identifier: string): string {
  return join(extensionDir(identifier), "repo");
}

function storageDir(identifier: string): string {
  return join(extensionDir(identifier), "storage");
}
function trustedRepoDir(identifier: string, label: string): string {
  const extensionRoot = resolveWithin(extensionsDir(), identifier, `${label} extension`);
  // `repo` may intentionally be a symlink for import-local development. Its
  // canonical directory becomes the trust root for every subsequent path.
  const resolvedRepo = realpathSync(join(extensionRoot, "repo"));
  if (!statSync(resolvedRepo).isDirectory()) {
    throw new Error(`${label} repo is not a directory`);
  }
  return resolvedRepo;
}

function trustedStorageDir(identifier: string, label: string): string {
  const extensionRoot = resolveWithin(extensionsDir(), identifier, `${label} extension`);
  return resolveWithin(extensionRoot, "storage", label);
}

/**
 * Cross-platform move. On Windows, freshly-cloned directories frequently hit
 * transient EPERM/EBUSY from antivirus, the search indexer, or git child handles
 * that haven't fully released. Retry a few times with backoff, then fall back to
 * copy+delete (which also covers cross-device EXDEV).
 */
function moveSync(from: string, to: string): void {
  const transientCodes = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err: any) {
      if (err.code === "EXDEV") break;
      if (!transientCodes.has(err.code)) throw err;
      if (attempt < delays.length) Bun.sleepSync(delays[attempt]);
    }
  }
  cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
  rmSync(from, { recursive: true, force: true });
}

// ─── Manifest parsing ────────────────────────────────────────────────────

async function readManifest(
  identifier: string,
  trustedRepo?: string,
): Promise<SpindleManifest> {
  const repo = trustedRepo ?? trustedRepoDir(identifier, "manifest");
  const candidates = ["spindle.json", "spindlefile", "spindlefile.json"] as const;
  let manifestPath: string | undefined;
  for (const candidateName of candidates) {
    const candidatePath = resolveWithin(repo, candidateName, "manifest");
    if (await Bun.file(candidatePath).exists()) {
      manifestPath = candidatePath;
      break;
    }
  }
  if (!manifestPath) {
    throw new Error(`spindle manifest not found in ${repo}`);
  }
  const raw = await Bun.file(manifestPath).text();
  const manifest: SpindleManifest = JSON.parse(raw);

  // Validate
  if (!manifest.identifier || !validateIdentifier(manifest.identifier)) {
    throw new Error(
      `Invalid identifier "${manifest.identifier}". Must match /^[a-z][a-z0-9_]*$/`
    );
  }
  if (!manifest.version) throw new Error("Missing version in spindle.json");
  if (!manifest.name) throw new Error("Missing name in spindle.json");
  if (!manifest.author) throw new Error("Missing author in spindle.json");
  manifest.github = normalizeSpindleHttpsUrl(manifest.github, "github");
  manifest.homepage = normalizeSpindleHttpsUrl(manifest.homepage, "homepage");

  return manifest;
}

async function readManifestFromPath(
  manifestPath: string,
  trustedRoot: string,
  options?: { allowMissingGithub?: boolean }
): Promise<SpindleManifest> {
  const checkedManifestPath = resolveWithin(trustedRoot, manifestPath, "manifest");
  if (!(await Bun.file(checkedManifestPath).exists())) {
    throw new Error(`spindle.json not found at ${manifestPath}`);
  }

  const raw = await Bun.file(checkedManifestPath).text();
  const manifest: SpindleManifest = JSON.parse(raw);

  if (!manifest.identifier || !validateIdentifier(manifest.identifier)) {
    throw new Error(
      `Invalid identifier "${manifest.identifier}". Must match /^[a-z][a-z0-9_]*$/`
    );
  }
  if (!manifest.version) throw new Error("Missing version in spindle.json");
  if (!manifest.name) throw new Error("Missing name in spindle.json");
  if (!manifest.author) throw new Error("Missing author in spindle.json");
  manifest.github = normalizeSpindleHttpsUrl(manifest.github, "github", {
    required: !options?.allowMissingGithub,
  });
  manifest.homepage = normalizeSpindleHttpsUrl(manifest.homepage, "homepage");

  return manifest;
}

function moveRootRepoToNestedRepo(extRootDir: string): void {
  const nestedRepoDir = join(extRootDir, "repo");
  mkdirSync(nestedRepoDir, { recursive: true });

  const entries = readdirSync(extRootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "repo" || entry.name === "storage") continue;

    const from = join(extRootDir, entry.name);
    const to = join(nestedRepoDir, entry.name);

    moveSync(from, to);
  }
}

async function ensureRepoLayoutForIdentifier(identifier: string): Promise<void> {
  const root = extensionDir(identifier);
  const rootManifestPath = join(root, "spindle.json");
  const rootSpindleFilePath = join(root, "spindlefile");
  const rootSpindleFileJsonPath = join(root, "spindlefile.json");
  const nestedManifestPath = join(root, "repo", "spindle.json");
  const nestedSpindleFilePath = join(root, "repo", "spindlefile");
  const nestedSpindleFileJsonPath = join(root, "repo", "spindlefile.json");

  if (
    (await Bun.file(nestedManifestPath).exists()) ||
    (await Bun.file(nestedSpindleFilePath).exists()) ||
    (await Bun.file(nestedSpindleFileJsonPath).exists())
  ) {
    return;
  }
  if (
    !(await Bun.file(rootManifestPath).exists()) &&
    !(await Bun.file(rootSpindleFilePath).exists()) &&
    !(await Bun.file(rootSpindleFileJsonPath).exists())
  ) {
    throw new Error(`No spindle.json found for local extension ${identifier}`);
  }

  moveRootRepoToNestedRepo(root);
}

function insertExtensionFromManifest(manifest: SpindleManifest): void {
  const db = getDb();
  const existing = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(manifest.identifier) as { id: string } | null;
  if (existing) return;

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO extensions (id, identifier, name, version, author, description, github, homepage, permissions, enabled, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}')`,
    [
      id,
      manifest.identifier,
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
    ]
  );
}

// Permissions that require explicit admin approval before granting
export const PRIVILEGED_PERMISSIONS = new Set([
  "app_manipulation",
  "cors_proxy",
  "generation",
  "interceptor",
  "context_handler",
  "macro_interceptor",
  "characters",
  "chats",
  "world_books",
  "presets",
  "regex_scripts",
  "databanks",
  "personas",
  "push_notification",
  "image_gen",
  "images",
  "web_search",
  "unsafe_eval",
]);

function grantRequestedPermissionsByDefault(
  identifier: string,
  permissions: readonly string[] | undefined
): void {
  const requested = Array.isArray(permissions) ? permissions : [];
  for (const perm of requested) {
    if (PRIVILEGED_PERMISSIONS.has(perm)) continue;
    grantPermission(identifier, perm);
  }
}

/**
 * Reconcile extension_grants with the current manifest permissions:
 * - Ensure every non-privileged manifest permission has a grant row
 * - Only auto-grant privileged permissions if they are genuinely new
 *   (not in previousPermissions) — existing privileged perms require manual approval
 * - Revoke grants for permissions no longer declared in the manifest
 */
function syncPermissionGrants(
  identifier: string,
  manifestPermissions: readonly string[],
  previousPermissions: readonly string[]
): void {
  const manifestSet = new Set(manifestPermissions);
  const previousSet = new Set(previousPermissions);
  const granted: Set<string> = new Set(getGrantedPermissions(identifier));

  // Ensure all manifest permissions are granted appropriately
  for (const perm of manifestPermissions) {
    if (granted.has(perm)) continue; // already granted

    if (PRIVILEGED_PERMISSIONS.has(perm)) {
      // Only auto-grant privileged perms that are genuinely new to the manifest
      // (not just missing from extension_grants while already declared)
      if (!previousSet.has(perm)) {
        // New privileged permission — skip, requires manual admin approval
      }
      // If it was in previousPermissions but grant is missing, it was
      // intentionally revoked by an admin — don't re-grant
    } else {
      // Non-privileged: always ensure granted
      grantPermission(identifier, perm);
    }
  }

  // Revoke grants for permissions removed from the manifest
  for (const perm of granted) {
    if (!manifestSet.has(perm)) {
      revokePermission(identifier, perm);
    }
  }
}

/**
 * Re-read spindle.json from disk and sync the DB row + permission grants
 * if anything has changed. Safe to call on every start — no-ops when the
 * manifest matches what the DB already has.
 */
export async function syncManifestToDb(identifier: string): Promise<void> {
  let manifest: SpindleManifest;
  try {
    manifest = await readManifest(identifier);
  } catch {
    // If manifest can't be read (e.g. repo missing), skip sync silently
    return;
  }

  const db = getDb();
  const row = db
    .query("SELECT name, version, author, description, github, homepage, permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as {
      name: string; version: string; author: string; description: string;
      github: string; homepage: string; permissions: string;
    } | null;
  if (!row) return;

  const dbPermissions: string[] = parsePermissionsSafe<string>(row.permissions);
  const manifestPermissions = manifest.permissions || [];

  // Check if the extensions row needs updating
  const metadataChanged =
    row.name !== manifest.name ||
    row.version !== manifest.version ||
    row.author !== manifest.author ||
    (row.description || "") !== (manifest.description || "") ||
    row.github !== manifest.github ||
    (row.homepage || "") !== (manifest.homepage || "");
  const permissionsChanged =
    JSON.stringify(dbPermissions) !== JSON.stringify(manifestPermissions);

  if (metadataChanged || permissionsChanged) {
    db.run(
      `UPDATE extensions SET name = ?, version = ?, author = ?, description = ?,
       github = ?, homepage = ?, permissions = ?, updated_at = unixepoch()
       WHERE identifier = ?`,
      [
        manifest.name,
        manifest.version,
        manifest.author,
        manifest.description || "",
        manifest.github,
        manifest.homepage || "",
        JSON.stringify(manifestPermissions),
        identifier,
      ]
    );
  }

  // Always reconcile grants against the manifest — even when the permissions
  // column hasn't changed, the extension_grants table may be out of sync
  // (e.g. manual DB edits, interrupted previous sync, etc.)
  syncPermissionGrants(identifier, manifestPermissions, dbPermissions);
}

function resolveWithin(base: string, requestedPath: string, label: string): string {
  if (typeof requestedPath !== "string") {
    throw new Error(`Path must be a string for ${label}`);
  }
  const baseAbs = resolve(base);
  const resolved = resolve(baseAbs, requestedPath);
  const insideLexically =
    resolved === baseAbs || resolved.startsWith(`${baseAbs}${sep}`);

  let baseReal: string;
  try {
    baseReal = realpathSync(baseAbs);
  } catch {
    throw new Error(`Path base does not exist for ${label}: ${base}`);
  }

  let probe = resolved;
  while (true) {
    let exists = false;
    try {
      lstatSync(probe);
      exists = true;
    } catch (error: unknown) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw new Error(`Unable to validate ${label}: ${requestedPath}`);
      }
    }
    if (exists) {
      let probeReal: string;
      try {
        probeReal = realpathSync(probe);
      } catch {
        throw new Error(`Unable to resolve ${label}: ${requestedPath}`);
      }
      const insideReal =
        probeReal === baseReal || probeReal.startsWith(`${baseReal}${sep}`);
      if (!insideReal) {
        throw new Error(
          `${insideLexically ? "Symlink escapes extension root" : "Path traversal detected"} in ${label}: ${requestedPath}`,
        );
      }
      return probe === resolved ? probeReal : resolved;
    }
    const parent = dirname(probe);
    if (parent === probe) {
      throw new Error(`Path target cannot be resolved for ${label}: ${requestedPath}`);
    }
    probe = parent;
  }
}

export function applyStorageSeeds(
  identifier: string,
  manifest: SpindleManifest,
  trustedRepo?: string,
): void {
  const seeds = Array.isArray(manifest.storage_seed_files)
    ? manifest.storage_seed_files
    : [];

  const repo = trustedRepo ?? trustedRepoDir(identifier, "storage seed source");
  const storagePath = storageDir(identifier);
  mkdirSync(storagePath, { recursive: true });
  const storage = trustedStorageDir(identifier, "storage seed destination");

  for (const seed of seeds) {
    if (!seed || typeof seed !== "object") continue;
    const from = typeof seed.from === "string" ? seed.from.trim() : "";
    if (!from) continue;
    const to = typeof seed.to === "string" && seed.to.trim() ? seed.to.trim() : from;
    const overwrite = seed.overwrite === true;
    const required = seed.required === true;

    const sourcePath = resolveWithin(repo, from, "storage_seed_files.from");
    const targetPath = resolveWithin(storage, to, "storage_seed_files.to");

    if (!existsSync(sourcePath)) {
      if (required) {
        throw new Error(`Required seed source missing: ${from}`);
      }
      continue;
    }

    const srcStat = statSync(sourcePath);
    if (srcStat.isDirectory()) {
      if (existsSync(targetPath) && !overwrite) {
        continue;
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, {
        recursive: true,
        force: overwrite,
        errorOnExist: false,
      });
      continue;
    }

    if (!srcStat.isFile()) continue;
    if (existsSync(targetPath) && !overwrite) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

// ─── Termux-aware Bun command builders ───────────────────────────────────
/**
 * Build a command array for `bun install`.
 * On Termux, `bun install` always needs proot wrapping (Android's seccomp
 * filter blocks certain syscalls) and `--backend=copyfile` (no hardlinks).
 * Mirrors start.sh's `_proot_bun()` + install_deps().
 */
export function bunInstallCmd(): string[] {
  const isTermux = process.env.LUMIVERSE_IS_TERMUX === "true";
  const isProot = process.env.LUMIVERSE_IS_PROOT === "true";

  if (!isTermux && !isProot) return ["bun", "install", "--ignore-scripts"];

  if (isProot) {
    // Inside proot-distro: proot already intercepts syscalls
    return ["bun", "install", "--ignore-scripts", "--backend=copyfile"];
  }

  // Native Termux: always wrap bun install in proot
  const bunPath = process.env.LUMIVERSE_BUN_PATH || "bun";
  const method = process.env.LUMIVERSE_BUN_METHOD;
  const prefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
  const glibcLd = `${prefix}/glibc/lib/ld-linux-aarch64.so.1`;

  if (method === "direct") {
    // bun-termux wrapper handles linker; proot adds syscall interception
    return ["proot", "--link2symlink", "-0", bunPath, "install", "--ignore-scripts", "--backend=copyfile"];
  }

  if (method === "grun") {
    // Keep using the user's working grun wrapper inside proot instead of
    // reconstructing ld.so arguments ourselves. Native Termux installs can
    // otherwise pass `grun bun --version` and still fail the real install path.
    return ["proot", "--link2symlink", "-0", "grun", bunPath, "install", "--ignore-scripts", "--backend=copyfile"];
  }

  // proot/unknown: explicit glibc linker + proot
  return [
    "proot", "--link2symlink", "-0",
    glibcLd, "--library-path", `${prefix}/glibc/lib`,
    bunPath, "install", "--ignore-scripts", "--backend=copyfile",
  ];
}

/**
 * Bun-on-Bun subprocesses that pipe stdout/stderr have been prone to host-process
 * assertion failures on Windows during long-running extension installs/builds.
 * Fall back to spawnSync there so the admin action may block briefly, but the
 * server stays alive. Allow an escape hatch for users who want to try newer Bun
 * builds without the fallback.
 */
export function shouldUseWindowsSpindleBunSyncFallback(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (platform !== "win32") return false;
  return env[WINDOWS_SPINDLE_ASYNC_BUN_OVERRIDE] !== "1";
}

function warnWindowsSpindleBunSyncFallback(context: string): void {
  if (!shouldUseWindowsSpindleBunSyncFallback() || warnedWindowsSpindleBunFallback.has(context)) {
    return;
  }
  warnedWindowsSpindleBunFallback.add(context);
  console.warn(
    `[Spindle] ${context} is using a synchronous Bun subprocess fallback on Windows to avoid known Bun.spawn pipe crashes. Set ${WINDOWS_SPINDLE_ASYNC_BUN_OVERRIDE}=1 to re-enable the async path.`,
  );
}

async function runSpindleBunSubprocess(
  cmd: string[],
  opts: { cwd: string; context: string },
): Promise<SpawnAsyncResult> {
  if (!shouldUseWindowsSpindleBunSyncFallback()) {
    return spawnAsync(cmd, { cwd: opts.cwd });
  }

  warnWindowsSpindleBunSyncFallback(opts.context);
  const proc = Bun.spawnSync({
    cmd,
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    timedOut: false,
  };
}

function formatCommandFailure(
  result: Pick<SpawnAsyncResult, "exitCode" | "stdout" | "stderr">,
  label: string,
): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  if (stdout) return stdout;
  return `${label} exited with code ${result.exitCode}`;
}

// ─── Build ───────────────────────────────────────────────────────────────

async function buildExtensionFromTrustedRepo(
  identifier: string,
  repo: string,
  trustedManifest?: SpindleManifest,
): Promise<void> {
  const manifest = trustedManifest ?? await readManifest(identifier, repo);

  const backendEntry = manifest.entry_backend || "dist/backend.js";
  const frontendEntry = manifest.entry_frontend || "dist/frontend.js";
  const backendOut = resolveWithin(repo, backendEntry, "entry_backend");
  const frontendOut = resolveWithin(repo, frontendEntry, "entry_frontend");

  // Always install dependencies first if package.json exists
  const pkgJson = join(repo, "package.json");
  if (existsSync(pkgJson)) {
    const install = await runSpindleBunSubprocess(bunInstallCmd(), {
      cwd: repo,
      context: `dependency install for ${identifier}`,
    });
    if (install.exitCode !== 0) {
      throw new Error(`Dependency install failed: ${formatCommandFailure(install, "bun install")}`);
    }
  }

  const declaredCaps = declaredCapabilitiesFromManifest(manifest);

  // If the repo ships pre-built dist/ (files tracked in git), skip build entirely
  const distDir = join(repo, "dist");
  if (existsSync(distDir)) {
    const lsFiles = await spawnAsync(["git", "ls-files", "dist"], { cwd: repo });
    if (lsFiles.exitCode === 0 && lsFiles.stdout.trim().length > 0) {
      await assertSafeBackendBundle(identifier, backendOut, declaredCaps);
      return;
    }
  }

  // Look for src/ to build from
  const srcDir = join(repo, "src");
  if (!existsSync(srcDir)) return;

  const buildDistDir = join(repo, "dist");

  mkdirSync(buildDistDir, { recursive: true });

  // Determine what needs building
  const backendSrc = join(srcDir, "backend.ts");
  const frontendSrc = join(srcDir, "frontend.ts");
  const needsBackendBuild = existsSync(backendSrc) && !existsSync(backendOut);
  const needsFrontendBuild = existsSync(frontendSrc) && !existsSync(frontendOut);

  // Build backend entry if source exists
  if (needsBackendBuild) {
    const proc = await runSpindleBunSubprocess(
      bunCmd("build", "src/backend.ts", "--outfile", backendEntry, "--target", "bun"),
      {
        cwd: repo,
        context: `backend build for ${identifier}`,
      }
    );
    if (proc.exitCode !== 0) {
      throw new Error(`Backend build failed: ${formatCommandFailure(proc, "bun build")}`);
    }
  }

  // Build frontend entry if source exists
  if (needsFrontendBuild) {
    const proc = await runSpindleBunSubprocess(
      bunCmd("build", "src/frontend.ts", "--outfile", frontendEntry, "--target", "browser"),
      {
        cwd: repo,
        context: `frontend build for ${identifier}`,
      }
    );
    if (proc.exitCode !== 0) {
      throw new Error(`Frontend build failed: ${formatCommandFailure(proc, "bun build")}`);
    }
  }

  await assertSafeBackendBundle(identifier, backendOut, declaredCaps);
}

export async function buildExtension(identifier: string): Promise<void> {
  const repo = trustedRepoDir(identifier, "extension build");
  await buildExtensionFromTrustedRepo(identifier, repo);
}

// ─── Install ─────────────────────────────────────────────────────────────

/**
 * Validate that a user-supplied repository URL is safe to hand to `git clone`.
 * Without this check, an owner could (accidentally or coerced) install from
 * `file:///etc/shadow`, `ssh://internal-host/repo`, or `git://` and exfiltrate
 * local files or probe internal services.
 */
function assertSafeGitUrl(rawUrl: string): void {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("Repository URL is required");
  }
  const url = rawUrl.trim();
  // Reject scp-style URLs ("user@host:path") and absolute paths outright; they
  // bypass URL parsing and let git treat the value as a local clone source.
  if (/^[\w.+-]+@[^:]+:/.test(url) || url.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(url)) {
    throw new Error("Repository URL must use https://");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Repository URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Repository URL protocol "${parsed.protocol}" is not allowed; use https://`);
  }
  if (!parsed.hostname) {
    throw new Error("Repository URL must include a hostname");
  }
}

export async function install(
  githubUrl: string,
  options?: { installScope?: InstallScope; installedByUserId?: string | null; branch?: string | null }
): Promise<ExtensionInfo> {
  assertSafeGitUrl(githubUrl);

  const baseDir = extensionsDir();
  mkdirSync(baseDir, { recursive: true });
  const installScope: InstallScope = options?.installScope === "user" ? "user" : "operator";
  const installedByUserId =
    options?.installedByUserId && options.installedByUserId.trim()
      ? options.installedByUserId.trim()
      : null;
  const branch = options?.branch && options.branch.trim() ? options.branch.trim() : null;

  // Clone to a temp dir first so we can read the manifest
  const tempDir = join(baseDir, `_temp_${Date.now()}`);
  const cloneCmd = ["git", "clone", "--depth", "1"];
  if (branch) {
    cloneCmd.push("--branch", branch);
  }
  cloneCmd.push(githubUrl, tempDir);
  const cloneProc = Bun.spawnSync({
    cmd: cloneCmd,
  });
  if (cloneProc.exitCode !== 0) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`git clone failed: ${cloneProc.stderr.toString()}`);
  }

  // Read manifest from cloned repo
  const manifestPath = join(tempDir, "spindle.json");
  if (!(await Bun.file(manifestPath).exists())) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error("No spindle.json found in repository");
  }

  const raw = await Bun.file(manifestPath).text();
  const manifest: SpindleManifest = JSON.parse(raw);

  if (!manifest.identifier || !validateIdentifier(manifest.identifier)) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      `Invalid identifier "${manifest.identifier}". Must match /^[a-z][a-z0-9_]*$/`
    );
  }
  manifest.github = normalizeSpindleHttpsUrl(manifest.github || githubUrl, "github", {
    required: true,
  });
  manifest.homepage = normalizeSpindleHttpsUrl(manifest.homepage, "homepage");

  // Check if already installed
  const db = getDb();
  const existing = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(manifest.identifier);
  if (existing) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Extension "${manifest.identifier}" is already installed`);
  }

  // Move temp dir to final location
  const extDir = extensionDir(manifest.identifier);
  const finalRepo = repoDir(manifest.identifier);
  mkdirSync(extDir, { recursive: true });

  // Move temp to repo dir
  try {
    moveSync(tempDir, finalRepo);
  } catch (err: any) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Failed to move cloned repo to extension directory: ${err.message}`);
  }

  // Create storage dir
  mkdirSync(storageDir(manifest.identifier), { recursive: true });

  // Build if needed
  await buildExtension(manifest.identifier);
  applyStorageSeeds(manifest.identifier, manifest);

  // Insert into DB
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO extensions (
      id, identifier, name, version, author, description, github, homepage,
      permissions, enabled, metadata, install_scope, installed_by_user_id, branch
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}', ?, ?, ?)`,
    [
      id,
      manifest.identifier,
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
      installScope,
      installedByUserId,
      branch,
    ]
  );

  return (await getExtension(id))!;
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function update(identifier: string): Promise<ExtensionInfo> {
  const repoPath = repoDir(identifier);
  if (!existsSync(repoPath)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }
  const repo = trustedRepoDir(identifier, "extension update");

  // Read manifest up-front so we can honor `dev_mode` before touching the
  // working tree. Extensions with `dev_mode: true` keep their local repo
  // contents intact — we skip the git checkout/clean/pull and just rebuild
  // + relaunch from whatever the developer has on disk.
  const initialManifest = await readManifest(identifier, repo);
  const devMode = (initialManifest as { dev_mode?: boolean }).dev_mode === true;

  if (!devMode) {
    // Clean build artifacts and installed dependencies so git pull succeeds.
    // We don't read stdout for these — ignore it to reduce pipe overhead.
    await spawnAsync(["git", "checkout", "."], { cwd: repo, ignoreStdout: true });
    await spawnAsync(["git", "clean", "-fd"], { cwd: repo, ignoreStdout: true });

    const pullProc = await spawnAsync(["git", "pull"], {
      cwd: repo,
      timeoutMs: 60_000,
    });
    if (pullProc.exitCode !== 0) {
      throw new Error(`git pull failed: ${pullProc.stderr}`);
    }
  }

  // Re-read manifest — in non-dev mode the pull may have modified it; in
  // dev mode we already have the current version.
  const manifest = devMode ? initialManifest : await readManifest(identifier, repo);

  const db = getDb();
  const existing = db
    .query("SELECT permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as { permissions: string } | null;
  const existingPermissions = existing
    ? (JSON.parse(existing.permissions || "[]") as string[])
    : [];
  const existingPermissionSet = new Set(existingPermissions);

  // Rebuild — only delete dist/ if it was locally built (not tracked in git).
  // Repos that ship pre-built dist/ should have those files preserved.
  const srcDir = join(repo, "src");
  const hasBuildableSrc =
    existsSync(srcDir) &&
    (existsSync(join(srcDir, "backend.ts")) || existsSync(join(srcDir, "frontend.ts")));

  if (hasBuildableSrc) {
    const distDir = join(repo, "dist");
    if (existsSync(distDir)) {
      const lsFiles = await spawnAsync(["git", "ls-files", "dist"], { cwd: repo });
      const distIsTracked = lsFiles.exitCode === 0 && lsFiles.stdout.trim().length > 0;
      if (!distIsTracked) {
        rmSync(distDir, { recursive: true });
      }
    }
  }
  await buildExtensionFromTrustedRepo(identifier, repo, manifest);
  applyStorageSeeds(identifier, manifest, repo);

  // Update DB
  db.run(
    `UPDATE extensions SET name = ?, version = ?, author = ?, description = ?,
     github = ?, homepage = ?, permissions = ?, updated_at = unixepoch()
     WHERE identifier = ?`,
    [
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
      identifier,
    ]
  );

  syncPermissionGrants(
    identifier,
    manifest.permissions || [],
    existingPermissions
  );

  return (await getExtensionByIdentifier(identifier))!;
}

// ─── Remove ──────────────────────────────────────────────────────────────

export function remove(identifier: string): void {
  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;

  if (!ext) throw new Error(`Extension not found: ${identifier}`);

  db.run("DELETE FROM extensions WHERE id = ?", [ext.id]);

  const dir = extensionDir(identifier);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Enable / Disable ────────────────────────────────────────────────────

export function enable(identifier: string): void {
  const db = getDb();
  const result = db.run(
    "UPDATE extensions SET enabled = 1, updated_at = unixepoch() WHERE identifier = ?",
    [identifier]
  );
  if (result.changes === 0) throw new Error(`Extension not found: ${identifier}`);

  // Grant non-privileged requested permissions on first enable
  const row = db
    .query("SELECT permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as { permissions: string } | null;
  if (row) {
    const requested = parsePermissionsSafe<string>(row.permissions);
    grantRequestedPermissionsByDefault(identifier, requested);
  }
}

export function disable(identifier: string): void {
  const db = getDb();
  const result = db.run(
    "UPDATE extensions SET enabled = 0, updated_at = unixepoch() WHERE identifier = ?",
    [identifier]
  );
  if (result.changes === 0) throw new Error(`Extension not found: ${identifier}`);
}

// ─── Permissions ─────────────────────────────────────────────────────────

export function grantPermission(
  identifier: string,
  permission: string
): void {
  if (!isManagedPermission(permission)) {
    throw new Error(`Invalid permission: ${permission}`);
  }

  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;
  if (!ext) throw new Error(`Extension not found: ${identifier}`);

  db.run(
    `INSERT OR IGNORE INTO extension_grants (id, extension_id, permission) VALUES (?, ?, ?)`,
    [crypto.randomUUID(), ext.id, permission]
  );
}

export function revokePermission(
  identifier: string,
  permission: string
): void {
  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;
  if (!ext) throw new Error(`Extension not found: ${identifier}`);

  db.run(
    "DELETE FROM extension_grants WHERE extension_id = ? AND permission = ?",
    [ext.id, permission]
  );
}

export function getGrantedPermissions(identifier: string): SpindlePermission[] {
  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;
  if (!ext) return [];

  const rows = db
    .query("SELECT permission FROM extension_grants WHERE extension_id = ?")
    .all(ext.id) as { permission: string }[];

  return rows.map((r) => r.permission as SpindlePermission);
}

export function hasPermission(
  identifier: string,
  permission: SpindlePermission
): boolean {
  return getGrantedPermissions(identifier).includes(permission);
}

// ─── Queries ─────────────────────────────────────────────────────────────

export async function list(): Promise<ExtensionInfo[]> {
  const db = getDb();
  const rows = db.query("SELECT * FROM extensions ORDER BY installed_at DESC").all() as any[];
  return Promise.all(rows.map(rowToExtensionInfo));
}

export async function listForUser(userId: string, role: string | null | undefined): Promise<ExtensionInfo[]> {
  if (role === "owner" || role === "admin") {
    return list();
  }

  const db = getDb();
  const rows = db
    .query(
      `SELECT * FROM extensions
       WHERE install_scope = 'operator' OR installed_by_user_id = ?
       ORDER BY installed_at DESC`
    )
    .all(userId) as any[];

  return Promise.all(rows.map(rowToExtensionInfo));
}

export async function getExtension(id: string): Promise<ExtensionInfo | null> {
  const db = getDb();
  const row = db.query("SELECT * FROM extensions WHERE id = ?").get(id) as any;
  return row ? rowToExtensionInfo(row) : null;
}

export async function getExtensionForUser(
  id: string,
  userId: string,
  role: string | null | undefined
): Promise<ExtensionInfo | null> {
  if (role === "owner" || role === "admin") {
    return getExtension(id);
  }

  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM extensions
       WHERE id = ? AND (install_scope = 'operator' OR installed_by_user_id = ?)`
    )
    .get(id, userId) as any;

  return row ? rowToExtensionInfo(row) : null;
}

export function canManageExtension(
  extension: ExtensionInfo,
  userId: string,
  role: string | null | undefined
): boolean {
  if (role === "owner" || role === "admin") return true;
  const metadata = (extension.metadata || {}) as Record<string, unknown>;
  return (
    metadata.install_scope === "user" &&
    typeof metadata.installed_by_user_id === "string" &&
    metadata.installed_by_user_id === userId
  );
}

export async function getExtensionByIdentifier(
  identifier: string
): Promise<ExtensionInfo | null> {
  const db = getDb();
  const row = db
    .query("SELECT * FROM extensions WHERE identifier = ?")
    .get(identifier) as any;
  return row ? rowToExtensionInfo(row) : null;
}

export async function getManifest(identifier: string): Promise<SpindleManifest> {
  return readManifest(identifier);
}

export async function getEnabledExtensions(): Promise<ExtensionInfo[]> {
  const db = getDb();
  const rows = db
    .query("SELECT * FROM extensions WHERE enabled = 1")
    .all() as any[];
  return Promise.all(rows.map(rowToExtensionInfo));
}

export function getEnabledExtensionIdentifiers(): string[] {
  const db = getDb();
  const rows = db
    .query("SELECT identifier FROM extensions WHERE enabled = 1")
    .all() as { identifier: string }[];
  return rows.map((r) => r.identifier);
}

export async function getFrontendBundlePath(identifier: string): Promise<string | null> {
  const repo = trustedRepoDir(identifier, "frontend entry");
  const manifest = await readManifest(identifier, repo);
  const entry = manifest.entry_frontend || "dist/frontend.js";
  const bundlePath = resolveWithin(repo, entry, "entry_frontend");
  return (await Bun.file(bundlePath).exists()) ? bundlePath : null;
}

export async function getFrontendBundleCacheKey(identifier: string): Promise<string | null> {
  const bundlePath = await getFrontendBundlePath(identifier);
  if (!bundlePath) return null;

  try {
    const stat = statSync(bundlePath);
    return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

export async function getBackendEntryPath(identifier: string): Promise<string | null> {
  const repo = trustedRepoDir(identifier, "backend entry");
  const manifest = await readManifest(identifier, repo);
  const entry = manifest.entry_backend || "dist/backend.js";
  const entryPath = resolveWithin(repo, entry, "entry_backend");
  if (!(await Bun.file(entryPath).exists())) return null;
  return validateBackendModuleGraph(
    identifier,
    entryPath,
    declaredCapabilitiesFromManifest(manifest),
  );
}

export function getStoragePath(identifier: string): string {
  const dir = storageDir(identifier);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getRepoPath(identifier: string): string {
  return trustedRepoDir(identifier, "extension repo");
}

export function getStoragePathForExtension(extension: ExtensionInfo): string {
  const metadata = (extension.metadata || {}) as Record<string, unknown>;
  const scope = metadata.install_scope;
  const owner = metadata.installed_by_user_id;

  if (scope === "user" && typeof owner === "string" && owner.trim()) {
    return getUserExtensionStoragePath(extension.identifier, owner);
  }

  return getStoragePath(extension.identifier);
}

export function getUserExtensionStoragePath(identifier: string, userId: string): string {
  const dir = getUserExtensionPath(userId, identifier);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function importLocalExtensions(): Promise<{
  imported: ExtensionInfo[];
  skipped: Array<{ identifier?: string; path: string; reason: string }>;
}> {
  const base = extensionsDir();
  mkdirSync(base, { recursive: true });

  const imported: ExtensionInfo[] = [];
  const skipped: Array<{ identifier?: string; path: string; reason: string }> = [];

  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.startsWith("_temp_"));

  for (const dirName of dirs) {
    const candidateRoot = join(base, dirName);

    try {
      const trustedCandidateRoot = resolveWithin(base, dirName, "local extension");
      // The documented local-development layout intentionally symlinks `repo`
      // to a source checkout outside data/extensions. Treat that resolved repo
      // as the trust root, while still containing every selected manifest to it.
      const nestedRepoPath = join(trustedCandidateRoot, "repo");
      const nestedRepo = existsSync(nestedRepoPath)
        ? realpathSync(nestedRepoPath)
        : null;
      const hasNestedRepo = nestedRepo !== null && statSync(nestedRepo).isDirectory();
      const candidates = [
        ...(nestedRepo !== null && hasNestedRepo
          ? [
              { base: nestedRepo, name: "spindle.json", nested: true },
              { base: nestedRepo, name: "spindlefile", nested: true },
              { base: nestedRepo, name: "spindlefile.json", nested: true },
            ]
          : []),
        { base: trustedCandidateRoot, name: "spindle.json", nested: false },
        { base: trustedCandidateRoot, name: "spindlefile", nested: false },
        { base: trustedCandidateRoot, name: "spindlefile.json", nested: false },
      ];

      let selected: {
        path: string;
        trustedRoot: string;
        nested: boolean;
      } | null = null;
      for (const candidate of candidates) {
        const manifestPath = resolveWithin(candidate.base, candidate.name, "manifest");
        if (await Bun.file(manifestPath).exists()) {
          selected = {
            path: manifestPath,
            trustedRoot: candidate.base,
            nested: candidate.nested,
          };
          break;
        }
      }
      if (!selected) {
        skipped.push({
          path: candidateRoot,
          reason: "No spindle manifest found (spindle.json/spindlefile)",
        });
        continue;
      }

      const manifest = await readManifestFromPath(selected.path, selected.trustedRoot, {
        allowMissingGithub: true,
      });
      const selectedRepoIdentity = selected.nested && lstatSync(nestedRepoPath).isSymbolicLink()
        ? statSync(selected.trustedRoot)
        : null;

      // If user dropped the repo directly under extensions/<folder>, normalize layout
      if (!selected.nested) {
        const desiredRoot = extensionDir(manifest.identifier);

        // If folder name differs from manifest identifier, move folder first
        if (candidateRoot !== desiredRoot) {
          if (existsSync(desiredRoot)) {
            throw new Error(
              `Target directory already exists for identifier ${manifest.identifier}`
            );
          }
          moveSync(candidateRoot, desiredRoot);
        }

        await ensureRepoLayoutForIdentifier(manifest.identifier);
      } else {
        // Already nested layout, but ensure root directory matches identifier if needed
        const desiredRoot = extensionDir(manifest.identifier);
        if (candidateRoot !== desiredRoot) {
          if (existsSync(desiredRoot)) {
            throw new Error(
              `Target directory already exists for identifier ${manifest.identifier}`
            );
          }
          moveSync(candidateRoot, desiredRoot);
        }
      }

      const importedRepo = trustedRepoDir(manifest.identifier, "local extension import");
      if (selectedRepoIdentity) {
        const importedRepoIdentity = statSync(importedRepo);
        if (
          importedRepoIdentity.dev !== selectedRepoIdentity.dev
          || importedRepoIdentity.ino !== selectedRepoIdentity.ino
        ) {
          throw new Error(`Local extension repo changed during import: ${manifest.identifier}`);
        }
      }
      mkdirSync(storageDir(manifest.identifier), { recursive: true });
      await buildExtensionFromTrustedRepo(manifest.identifier, importedRepo, manifest);
      applyStorageSeeds(manifest.identifier, manifest, importedRepo);
      insertExtensionFromManifest(manifest);

      const ext = await getExtensionByIdentifier(manifest.identifier);
      if (ext) imported.push(ext);
    } catch (err: unknown) {
      skipped.push({
        path: candidateRoot,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { imported, skipped };
}
// ─── Branch Management ────────────────────────────────────────────────────

/** List remote branches from a GitHub URL (pre-install discovery). */
export function listRemoteBranches(githubUrl: string): string[] {
  const proc = Bun.spawnSync({
    cmd: ["git", "ls-remote", "--heads", githubUrl],
    timeout: 15_000,
  });
  if (proc.exitCode !== 0) {
    throw new Error(`Failed to list remote branches: ${proc.stderr.toString()}`);
  }
  const output = proc.stdout.toString().trim();
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.replace(/^.*refs\/heads\//, ""))
    .filter(Boolean);
}

/** List branches for an already-installed extension by querying its remote. */
export function getBranches(identifier: string): { current: string | null; branches: string[] } {
  const repoPath = repoDir(identifier);
  if (!existsSync(repoPath)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }
  const repo = trustedRepoDir(identifier, "extension branches");

  // Get current branch
  const headProc = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    cwd: repo,
  });
  const current = headProc.exitCode === 0 ? headProc.stdout.toString().trim() : null;

  // List remote branches
  const proc = Bun.spawnSync({
    cmd: ["git", "ls-remote", "--heads", "origin"],
    cwd: repo,
    timeout: 15_000,
  });
  if (proc.exitCode !== 0) {
    return { current, branches: current ? [current] : [] };
  }
  const output = proc.stdout.toString().trim();
  const branches = output
    ? output
        .split("\n")
        .map((line) => line.replace(/^.*refs\/heads\//, ""))
        .filter(Boolean)
    : [];

  return { current, branches };
}

/** Switch an installed extension to a different branch, rebuild, and update DB. */
export async function switchBranch(
  identifier: string,
  branch: string
): Promise<ExtensionInfo> {
  const repoPath = repoDir(identifier);
  if (!existsSync(repoPath)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }
  const repo = trustedRepoDir(identifier, "extension branch switch");

  const runGitStep = async (
    cmd: string[],
    label: string,
    options: { timeoutMs?: number; ignoreStdout?: boolean } = {}
  ): Promise<void> => {
    const proc = await spawnAsync(cmd, {
      cwd: repo,
      timeoutMs: options.timeoutMs,
      ignoreStdout: options.ignoreStdout,
    });
    if (proc.exitCode === 0) return;

    const reason = proc.timedOut
      ? `timed out after ${(options.timeoutMs ?? 0) / 1000}s`
      : proc.stderr.trim() || proc.stdout.trim() || "unknown error";
    throw new Error(`${label} failed: ${reason}`);
  };

  // Clean working tree
  await runGitStep(["git", "checkout", "."], "git checkout .", {
    ignoreStdout: true,
    timeoutMs: 15_000,
  });
  await runGitStep(["git", "clean", "-fd"], "git clean -fd", {
    ignoreStdout: true,
    timeoutMs: 15_000,
  });

  // Widen the fetch refspec — shallow/single-branch clones only track one branch
  await runGitStep(
    ["git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    "git config remote.origin.fetch",
    { timeoutMs: 15_000 }
  );

  // Fetch the target branch (--depth=1 to keep it shallow)
  await runGitStep(["git", "fetch", "--depth", "1", "origin", branch], `git fetch ${branch}`, {
    timeoutMs: 30_000,
  });

  // Checkout the branch
  await runGitStep(["git", "checkout", "-B", branch, `origin/${branch}`], `git checkout ${branch}`, {
    timeoutMs: 30_000,
  });

  // Re-read manifest
  const manifest = await readManifest(identifier, repo);

  const db = getDb();
  const existing = db
    .query("SELECT permissions FROM extensions WHERE identifier = ?")
    .get(identifier) as { permissions: string } | null;
  const existingPermissions = existing
    ? (JSON.parse(existing.permissions || "[]") as string[])
    : [];

  // Rebuild — only delete dist/ if it was locally built (not tracked in git).
  // Repos that ship pre-built dist/ should have those files preserved.
  const srcDir = join(repo, "src");
  const hasBuildableSrc =
    existsSync(srcDir) &&
    (existsSync(join(srcDir, "backend.ts")) || existsSync(join(srcDir, "frontend.ts")));

  if (hasBuildableSrc) {
    const distDir = join(repo, "dist");
    if (existsSync(distDir)) {
      const lsFiles = await spawnAsync(["git", "ls-files", "dist"], { cwd: repo });
      const distIsTracked = lsFiles.exitCode === 0 && lsFiles.stdout.trim().length > 0;
      if (!distIsTracked) {
        rmSync(distDir, { recursive: true });
      }
    }
  }
  await buildExtensionFromTrustedRepo(identifier, repo, manifest);
  applyStorageSeeds(identifier, manifest, repo);

  // Update DB
  db.run(
    `UPDATE extensions SET name = ?, version = ?, author = ?, description = ?,
     github = ?, homepage = ?, permissions = ?, branch = ?, updated_at = unixepoch()
     WHERE identifier = ?`,
    [
      manifest.name,
      manifest.version,
      manifest.author,
      manifest.description || "",
      manifest.github,
      manifest.homepage || "",
      JSON.stringify(manifest.permissions || []),
      branch,
      identifier,
    ]
  );

  syncPermissionGrants(
    identifier,
    manifest.permissions || [],
    existingPermissions
  );

  return (await getExtensionByIdentifier(identifier))!;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function rowToExtensionInfo(row: any): Promise<ExtensionInfo> {
  const identifier = row.identifier;
  const permissions: SpindlePermission[] = parsePermissionsSafe<SpindlePermission>(row.permissions);
  const granted = getGrantedPermissions(identifier);

  let hasFrontend = false;
  let hasBackend = false;
  try {
    hasFrontend = (await getFrontendBundlePath(identifier)) !== null;
    hasBackend = (await getBackendEntryPath(identifier)) !== null;
  } catch {
    // Extension files may not exist
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || "{}") || {};
  } catch {
    metadata = {};
  }

  metadata.install_scope = row.install_scope || "operator";
  metadata.installed_by_user_id = row.installed_by_user_id || null;
  metadata.branch = row.branch || null;

  return {
    id: row.id,
    identifier,
    name: row.name,
    version: row.version,
    author: row.author,
    description: row.description || "",
    github: row.github,
    homepage: row.homepage || "",
    permissions,
    granted_permissions: granted,
    enabled: row.enabled === 1,
    installed_at: row.installed_at,
    updated_at: row.updated_at,
    has_frontend: hasFrontend,
    has_backend: hasBackend,
    // Reflect actual worker state. The previous literal "stopped : stopped"
    // ternary always reported stopped, masking running workers in the UI.
    // Lazy require avoids a circular import (lifecycle.ts already imports
    // managerSvc), which would otherwise resolve isRunning to undefined on
    // first load.
    status: (require("./lifecycle") as typeof import("./lifecycle")).isRunning(row.id) ? "running" : "stopped",
    metadata,
  };
}
