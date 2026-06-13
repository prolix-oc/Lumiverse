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
  copyFileSync,
  cpSync,
} from "fs";
import { join, resolve, dirname, sep } from "path";
import { getUserExtensionPath } from "../auth/provision";
import { spawnAsync } from "./spawn-async";
import { normalizeSpindleHttpsUrl } from "./url-safety";

export type InstallScope = "operator" | "user";
type ManagedSpindlePermission = SpindlePermission | "databanks" | "presets";

function isManagedPermission(permission: string): permission is ManagedSpindlePermission {
  return permission === "databanks" || permission === "presets" || isValidPermission(permission);
}

type BackendSafetyCheck = {
  label: string;
  regex: RegExp;
};

type SourceSpan = { start: number; end: number };
type ScannableSource = { text: string; ignoredSpans: SourceSpan[] };

const DANGEROUS_MODULE_LABELS = new Map<string, string>([
  ["fs", "filesystem module access"],
  ["fs/promises", "filesystem module access"],
  ["node:fs", "filesystem module access"],
  ["node:fs/promises", "filesystem module access"],
  ["child_process", "subprocess module access"],
  ["node:child_process", "subprocess module access"],
  ["net", "direct socket module access"],
  ["tls", "direct socket module access"],
  ["dgram", "direct socket module access"],
  ["http", "direct socket module access"],
  ["https", "direct socket module access"],
  ["node:net", "direct socket module access"],
  ["node:tls", "direct socket module access"],
  ["node:dgram", "direct socket module access"],
  ["node:http", "direct socket module access"],
  ["node:https", "direct socket module access"],
  ["worker_threads", "worker or cluster module access"],
  ["cluster", "worker or cluster module access"],
  ["node:worker_threads", "worker or cluster module access"],
  ["node:cluster", "worker or cluster module access"],
  ["bun:sqlite", "direct SQLite module access"],
  ["node:sqlite", "direct SQLite module access"],
]);

const DANGEROUS_BUN_PROPERTIES = new Set(["file", "write", "spawn", "spawnSync", "serve", "connect", "listen"]);
const DANGEROUS_PROCESS_PROPERTIES = new Set(["env", "exit", "kill", "chdir", "dlopen"]);

const DANGEROUS_BACKEND_CHECKS: BackendSafetyCheck[] = [
  {
    label: "filesystem module access",
    regex: /(?:from\s*["'`](?:node:)?fs(?:\/promises)?["'`]|require\s*\(\s*["'`](?:node:)?fs(?:\/promises)?["'`]\s*\)|import\s*\(\s*["'`](?:node:)?fs(?:\/promises)?["'`]\s*\))/,
  },
  {
    label: "subprocess module access",
    regex: /(?:from\s*["'`](?:node:)?child_process["'`]|require\s*\(\s*["'`](?:node:)?child_process["'`]\s*\)|import\s*\(\s*["'`](?:node:)?child_process["'`]\s*\))/,
  },
  {
    label: "direct socket module access",
    regex: /(?:from\s*["'`](?:node:)?(?:net|tls|dgram|http|https)["'`]|require\s*\(\s*["'`](?:node:)?(?:net|tls|dgram|http|https)["'`]\s*\)|import\s*\(\s*["'`](?:node:)?(?:net|tls|dgram|http|https)["'`]\s*\))/,
  },
  {
    label: "worker or cluster module access",
    regex: /(?:from\s*["'`](?:node:)?(?:worker_threads|cluster)["'`]|require\s*\(\s*["'`](?:node:)?(?:worker_threads|cluster)["'`]\s*\)|import\s*\(\s*["'`](?:node:)?(?:worker_threads|cluster)["'`]\s*\))/,
  },
  {
    label: "direct SQLite module access",
    regex: /(?:from\s*["'`](?:bun:sqlite|node:sqlite)["'`]|require\s*\(\s*["'`](?:bun:sqlite|node:sqlite)["'`]\s*\)|import\s*\(\s*["'`](?:bun:sqlite|node:sqlite)["'`]\s*\))/,
  },
  {
    label: "dangerous Bun system API usage",
    regex: /\bBun\.(?:file|write|spawn|spawnSync|serve|connect|listen)\b/,
  },
  {
    label: "dangerous process API usage",
    regex: /\bprocess\.(?:env|exit|kill|chdir|dlopen)\b/,
  },
];

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
    if (REGEX_CONTEXT_CHARS.has(ch)) return true;
    // Identifier scan — keyword or value?
    if (/[A-Za-z_$]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k -= 1;
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
  if (index === undefined || index < 0) return false;
  for (const span of spans) {
    if (index < span.start) return false;
    if (index >= span.start && index < span.end) return true;
  }
  return false;
}

function createScannableSources(content: string): ScannableSource[] {
  const normalized = normalizeJavaScriptForSafetyScan(content);
  const texts = normalized === content ? [content] : [content, normalized];
  return texts.map((text) => ({ text, ignoredSpans: collectIgnoredSpans(text) }));
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

function decodeQuotedLiteral(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.test(trimmed)) return null;
  const quote = trimmed[0];
  const body = trimmed.slice(1, -1);
  if (quote === "`") return body.replace(/\$\{[^}]*\}/g, "");
  if (quote === '"') {
    try {
      return JSON.parse(trimmed);
    } catch {
      return body;
    }
  }
  return body.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
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
  const trimmed = raw.trim();
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

function addDynamicModuleHits(source: ScannableSource, hits: Set<string>): void {
  // Only the BARE dynamic-import operator `import(…)` and the global
  // `require(…)` are real module-load surfaces. Member calls (`x.require(…)`,
  // `ns.import(…)`) and shorthand method definitions (`require(name) { … }`)
  // are unrelated: extensions routinely ship a scripting API whose methods are
  // literally named `require`/`import` (e.g. RisuAI-compat layers). The
  // negative lookbehind `(?<![.\w$])` drops member access and identifier-
  // prefixed names; the trailing-`{` check below drops method definitions.
  // No coverage is lost — a constant dangerous specifier on ANY receiver is
  // still caught by DANGEROUS_BACKEND_CHECKS, and a dynamic `globalThis.require`
  // is caught at runtime by guardRequire (a real override, unlike `import()`).
  for (const match of matchOutsideIgnored(source, /(?<![.\w$])(?:require|import)\s*\(([^;\n]{1,300})\)/)) {
    if (match.index !== undefined) {
      const tail = source.text.slice(match.index + match[0].length);
      if (/^\s*\{/.test(tail)) continue; // `require(name) { … }` — a definition
    }
    const resolved = resolveStaticModuleSpecifier(match[1]);
    if (resolved === null) {
      // Specifier is not a provable constant — fail closed. We cannot tell
      // whether it resolves to `node:fs`, `child_process`, etc., so block it.
      hits.add("dynamic module access");
      continue;
    }
    const label = DANGEROUS_MODULE_LABELS.get(resolved);
    if (label) hits.add(label);
  }
}

function addPropertyAccessHits(
  source: ScannableSource,
  objectName: string,
  properties: Set<string>,
  label: string,
  hits: Set<string>
): void {
  const escapedObject = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dotAccess = new RegExp(`\\b${escapedObject}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
  for (const match of matchOutsideIgnored(source, dotAccess)) {
    if (properties.has(match[1])) hits.add(label);
  }

  const computedAccess = new RegExp(`\\b${escapedObject}\\s*\\[([^\\]]{1,300})\\]`, "g");
  for (const match of matchOutsideIgnored(source, computedAccess)) {
    const property = decodeSimpleStringExpression(match[1]);
    if (property && properties.has(property)) hits.add(label);
  }
}

function addAliasPropertyHits(source: ScannableSource, hits: Set<string>): void {
  const aliases = new Map<string, "Bun" | "process">();
  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(Bun|process)\b/)) {
    aliases.set(match[1], match[2] as "Bun" | "process");
  }

  for (const [alias, aliasSource] of aliases) {
    addPropertyAccessHits(
      source,
      alias,
      aliasSource === "Bun" ? DANGEROUS_BUN_PROPERTIES : DANGEROUS_PROCESS_PROPERTIES,
      aliasSource === "Bun" ? "dangerous Bun system API usage" : "dangerous process API usage",
      hits
    );
  }
}

function addDestructuringHits(source: ScannableSource, hits: Set<string>): void {
  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*Bun\b/)) {
    for (const prop of match[1].split(",")) {
      const name = prop.trim().split(/\s*:/, 1)[0]?.trim();
      if (DANGEROUS_BUN_PROPERTIES.has(name)) hits.add("dangerous Bun system API usage");
    }
  }

  for (const match of matchOutsideIgnored(source, /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\b/)) {
    for (const prop of match[1].split(",")) {
      const name = prop.trim().split(/\s*:/, 1)[0]?.trim();
      if (DANGEROUS_PROCESS_PROPERTIES.has(name)) hits.add("dangerous process API usage");
    }
  }
}

/**
 * Maps a scanner label to the manifest-declared capability that, when
 * present, suppresses that label. Capabilities are install-time opt-ins
 * declared in `spindle.json`'s `requested_capabilities` field; the user
 * grants them on install just like `permissions`. Only labels with a
 * meaningful false-positive rate get a capability mapping — filesystem,
 * subprocess, sockets, sqlite, workers, Bun system APIs, and process APIs
 * remain hard-blocked with no opt-in available.
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

export function detectDangerousBackendCapabilities(
  content: string,
  declared: ReadonlySet<SpindleCapability> = new Set(),
): string[] {
  const hits = new Set<string>();
  for (const source of createScannableSources(content)) {
    for (const check of DANGEROUS_BACKEND_CHECKS) {
      if (matchOutsideIgnored(source, check.regex).length > 0) {
        hits.add(check.label);
      }
    }
    addDynamicModuleHits(source, hits);
    addPropertyAccessHits(source, "Bun", DANGEROUS_BUN_PROPERTIES, "dangerous Bun system API usage", hits);
    addPropertyAccessHits(source, "process", DANGEROUS_PROCESS_PROPERTIES, "dangerous process API usage", hits);
    addAliasPropertyHits(source, hits);
    addDestructuringHits(source, hits);
    if (matchOutsideIgnored(source, /\bObject\.getOwnPropertyDescriptor\s*\(\s*process\s*,\s*["'`]env["'`]/).length > 0) {
      hits.add("dangerous process API usage");
    }

    // Dynamic code execution — `eval(` / `Function(`. The empty-body
    // Function probe (`new Function("")`) is excluded as a known
    // feature-detect pattern with no real execution capability.
    const dynExecMatches = matchOutsideIgnored(source, /\beval\s*\(|\bFunction\s*\(/);
    for (const match of dynExecMatches) {
      if (match.index === undefined) continue;
      const matchedText = match[0];
      if (matchedText.startsWith("Function") && isEmptyFunctionProbe(source, match.index)) continue;
      hits.add("dynamic code execution");
      break;
    }

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

async function assertSafeBackendBundle(
  identifier: string,
  backendPath: string,
  declared: ReadonlySet<SpindleCapability> = new Set(),
): Promise<void> {
  if (!(await Bun.file(backendPath).exists())) return;

  const blocked = detectDangerousBackendCapabilities(
    await Bun.file(backendPath).text(),
    declared,
  );
  if (blocked.length === 0) return;

  throw new Error(
    `Extension "${identifier}" uses blocked backend capabilities: ${blocked.join(", ")}`
  );
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

async function readManifest(identifier: string): Promise<SpindleManifest> {
  const repo = repoDir(identifier);
  const candidates = [
    join(repo, "spindle.json"),
    join(repo, "spindlefile"),
    join(repo, "spindlefile.json"),
  ];
  let manifestPath: string | undefined;
  for (const p of candidates) {
    if (await Bun.file(p).exists()) {
      manifestPath = p;
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
  options?: { allowMissingGithub?: boolean }
): Promise<SpindleManifest> {
  if (!(await Bun.file(manifestPath).exists())) {
    throw new Error(`spindle.json not found at ${manifestPath}`);
  }

  const raw = await Bun.file(manifestPath).text();
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
  const baseAbs = resolve(base);
  const resolved = resolve(baseAbs, requestedPath);
  const inside = resolved === baseAbs || resolved.startsWith(`${baseAbs}${sep}`);
  if (!inside) {
    throw new Error(`Path traversal detected in ${label}: ${requestedPath}`);
  }
  return resolved;
}

function applyStorageSeeds(identifier: string, manifest: SpindleManifest): void {
  const seeds = Array.isArray(manifest.storage_seed_files)
    ? manifest.storage_seed_files
    : [];
  if (seeds.length === 0) return;

  const repo = repoDir(identifier);
  const storage = storageDir(identifier);
  mkdirSync(storage, { recursive: true });

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
// On Termux, the bare `bun` binary can't execute natively. start.sh detects
// the working invocation method and exports it via env vars so we can mirror
// the same wrapping here when spawning bun subprocesses.

/**
 * Build a command array for running `bun <args>`.
 * Mirrors start.sh's `_bun()` wrapper.
 */
export function bunCmd(...args: string[]): string[] {
  const method = process.env.LUMIVERSE_BUN_METHOD;
  const bunPath = process.env.LUMIVERSE_BUN_PATH;

  if (!method || !bunPath) return ["bun", ...args];

  switch (method) {
    case "direct":
      return [bunPath, ...args];
    case "grun":
      return ["grun", bunPath, ...args];
    case "proot": {
      const prefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
      return [
        "proot", "--link2symlink", "-0",
        `${prefix}/glibc/lib/ld-linux-aarch64.so.1`,
        "--library-path", `${prefix}/glibc/lib`,
        bunPath, ...args,
      ];
    }
    default:
      return [bunPath, ...args];
  }
}

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

  // grun/proot: explicit glibc linker + proot
  return [
    "proot", "--link2symlink", "-0",
    glibcLd, "--library-path", `${prefix}/glibc/lib`,
    bunPath, "install", "--ignore-scripts", "--backend=copyfile",
  ];
}

// ─── Build ───────────────────────────────────────────────────────────────

export async function buildExtension(identifier: string): Promise<void> {
  const repo = repoDir(identifier);
  const manifest = await readManifest(identifier);

  const backendEntry = manifest.entry_backend || "dist/backend.js";
  const frontendEntry = manifest.entry_frontend || "dist/frontend.js";
  const backendOut = resolveWithin(repo, backendEntry, "entry_backend");
  const frontendOut = resolveWithin(repo, frontendEntry, "entry_frontend");

  // Always install dependencies first if package.json exists
  const pkgJson = join(repo, "package.json");
  if (existsSync(pkgJson)) {
    const install = await spawnAsync(bunInstallCmd(), { cwd: repo });
    if (install.exitCode !== 0) {
      throw new Error(`Dependency install failed: ${install.stderr}`);
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
    const proc = await spawnAsync(
      bunCmd("build", "src/backend.ts", "--outfile", backendEntry, "--target", "bun"),
      { cwd: repo }
    );
    if (proc.exitCode !== 0) {
      throw new Error(`Backend build failed: ${proc.stderr}`);
    }
  }

  // Build frontend entry if source exists
  if (needsFrontendBuild) {
    const proc = await spawnAsync(
      bunCmd("build", "src/frontend.ts", "--outfile", frontendEntry, "--target", "browser"),
      { cwd: repo }
    );
    if (proc.exitCode !== 0) {
      throw new Error(`Frontend build failed: ${proc.stderr}`);
    }
  }

  await assertSafeBackendBundle(identifier, backendOut, declaredCaps);
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
  const repo = repoDir(identifier);
  if (!existsSync(repo)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }

  // Read manifest up-front so we can honor `dev_mode` before touching the
  // working tree. Extensions with `dev_mode: true` keep their local repo
  // contents intact — we skip the git checkout/clean/pull and just rebuild
  // + relaunch from whatever the developer has on disk.
  const initialManifest = await readManifest(identifier);
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
  const manifest = devMode ? initialManifest : await readManifest(identifier);

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
  await buildExtension(identifier);
  applyStorageSeeds(identifier, manifest);

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

export function getGrantedPermissions(identifier: string): ManagedSpindlePermission[] {
  const db = getDb();
  const ext = db
    .query("SELECT id FROM extensions WHERE identifier = ?")
    .get(identifier) as { id: string } | null;
  if (!ext) return [];

  const rows = db
    .query("SELECT permission FROM extension_grants WHERE extension_id = ?")
    .all(ext.id) as { permission: string }[];

  return rows.map((r) => r.permission as ManagedSpindlePermission);
}

export function hasPermission(
  identifier: string,
  permission: ManagedSpindlePermission
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
  const manifest = await readManifest(identifier);
  const entry = manifest.entry_frontend || "dist/frontend.js";
  const repo = repoDir(identifier);
  const bundlePath = resolveWithin(repo, entry, "entry_frontend");
  return (await Bun.file(bundlePath).exists()) ? bundlePath : null;
}

export async function getBackendEntryPath(identifier: string): Promise<string | null> {
  const manifest = await readManifest(identifier);
  const entry = manifest.entry_backend || "dist/backend.js";
  const repo = repoDir(identifier);
  const entryPath = resolveWithin(repo, entry, "entry_backend");
  if (!(await Bun.file(entryPath).exists())) return null;
  await assertSafeBackendBundle(identifier, entryPath, declaredCapabilitiesFromManifest(manifest));
  return entryPath;
}

export function getStoragePath(identifier: string): string {
  const dir = storageDir(identifier);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getRepoPath(identifier: string): string {
  return repoDir(identifier);
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
      const nestedManifestPath = join(candidateRoot, "repo", "spindle.json");
      const nestedSpindleFilePath = join(candidateRoot, "repo", "spindlefile");
      const nestedSpindleFileJsonPath = join(candidateRoot, "repo", "spindlefile.json");
      const rootManifestPath = join(candidateRoot, "spindle.json");
      const rootSpindleFilePath = join(candidateRoot, "spindlefile");
      const rootSpindleFileJsonPath = join(candidateRoot, "spindlefile.json");

      let manifestPath: string | null = null;
      if (await Bun.file(nestedManifestPath).exists()) manifestPath = nestedManifestPath;
      else if (await Bun.file(nestedSpindleFilePath).exists()) manifestPath = nestedSpindleFilePath;
      else if (await Bun.file(nestedSpindleFileJsonPath).exists()) manifestPath = nestedSpindleFileJsonPath;
      else if (await Bun.file(rootManifestPath).exists()) manifestPath = rootManifestPath;
      else if (await Bun.file(rootSpindleFilePath).exists()) manifestPath = rootSpindleFilePath;
      else if (await Bun.file(rootSpindleFileJsonPath).exists()) manifestPath = rootSpindleFileJsonPath;
      else {
        skipped.push({
          path: candidateRoot,
          reason: "No spindle manifest found (spindle.json/spindlefile)",
        });
        continue;
      }

      const manifest = await readManifestFromPath(manifestPath, {
        allowMissingGithub: true,
      });

      // If user dropped the repo directly under extensions/<folder>, normalize layout
      if (
        manifestPath === rootManifestPath ||
        manifestPath === rootSpindleFilePath ||
        manifestPath === rootSpindleFileJsonPath
      ) {
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

      mkdirSync(storageDir(manifest.identifier), { recursive: true });
      await buildExtension(manifest.identifier);
      applyStorageSeeds(manifest.identifier, manifest);
      insertExtensionFromManifest(manifest);

      const ext = await getExtensionByIdentifier(manifest.identifier);
      if (ext) imported.push(ext);
    } catch (err: any) {
      skipped.push({
        path: candidateRoot,
        reason: err?.message || "Unknown error",
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
  const repo = repoDir(identifier);
  if (!existsSync(repo)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }

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
  const repo = repoDir(identifier);
  if (!existsSync(repo)) {
    throw new Error(`Extension repo not found: ${identifier}`);
  }

  // Clean working tree
  Bun.spawnSync({ cmd: ["git", "checkout", "."], cwd: repo });
  Bun.spawnSync({ cmd: ["git", "clean", "-fd"], cwd: repo });

  // Widen the fetch refspec — shallow/single-branch clones only track one branch
  Bun.spawnSync({
    cmd: ["git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    cwd: repo,
  });

  // Fetch the target branch (--depth=1 to keep it shallow)
  const fetchProc = Bun.spawnSync({
    cmd: ["git", "fetch", "--depth", "1", "origin", branch],
    cwd: repo,
    timeout: 30_000,
  });
  if (fetchProc.exitCode !== 0) {
    throw new Error(`git fetch failed: ${fetchProc.stderr.toString()}`);
  }

  // Checkout the branch
  const checkoutProc = Bun.spawnSync({
    cmd: ["git", "checkout", "-B", branch, `origin/${branch}`],
    cwd: repo,
  });
  if (checkoutProc.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkoutProc.stderr.toString()}`);
  }

  // Re-read manifest
  const manifest = await readManifest(identifier);

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
      const lsFiles = Bun.spawnSync({
        cmd: ["git", "ls-files", "dist"],
        cwd: repo,
      });
      const distIsTracked = lsFiles.exitCode === 0 && lsFiles.stdout.toString().trim().length > 0;
      if (!distIsTracked) {
        rmSync(distDir, { recursive: true });
      }
    }
  }
  await buildExtension(identifier);
  applyStorageSeeds(identifier, manifest);

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
  const permissions: ManagedSpindlePermission[] = parsePermissionsSafe<ManagedSpindlePermission>(row.permissions);
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
