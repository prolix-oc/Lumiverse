import { normalizeJsonInput, shieldDataBraces, shieldJsonStrings } from "./json-utils";
import type { MacroEnv } from "./types";

/**
 * `<json>…</json>` blocks let chat messages carry machine-readable state that
 * regex scripts, extensions, and the model must receive exactly as written.
 * Message content goes through several macro passes, and each one would expand
 * `{{…}}` inside JSON strings, unescape `\{`, rewrite `<user>`, and heal quote
 * spacing, so valid blocks in the message's own text are held out of every
 * pass. A macro that reads a held-out block, such as a scoped setter reading
 * its body, gets it back through `readJsonInput`.
 *
 * A block runs from `<json>` (any case, no attributes) to the first `</json>`
 * outside a JSON string, so its strings may hold either tag, and counts only
 * when the text between parses as JSON. Anything else stays ordinary text, so
 * `<json>{{getchatvar::state}}</json>` still fills in. A block inside a macro
 * tag, as in `{{setchatvar::state::<json>…</json>}}`, stays ordinary text too:
 * it belongs to the macro, so a `}}` in it closes the macro, as in presets.
 * A scan that rejects too many candidates stops, and the rest of the text may
 * hold blocks it never saw, so a message it stopped in gets no macro pass.
 * Display applies the same rules (frontend/src/lib/jsonBlocks.ts).
 */

export interface JsonBlock {
  /** Offset of the opening tag. */
  start: number;
  /** Offset just past the closing tag. */
  end: number;
  /** The block exactly as written, tags included. */
  source: string;
  /** The text between the tags. */
  inner: string;
  /** `inner` parsed. */
  value: unknown;
}

/** The blocks a scan found, and where it stopped. */
export interface JsonBlockScan {
  blocks: JsonBlock[];
  /**
   * The text's length, or the opener of the candidate that reached the
   * rejection cap. The scan classifies nothing from there on, so that text
   * may hold blocks it never saw.
   */
  stoppedAt: number;
}

const OPEN_TAG_RE = /<json>/gi;
// Either tag, tested where a `<` sits.
const TAG_AT_RE = /<\/?json>/iy;
const OPEN_TAG_LENGTH = "<json>".length;
const CLOSE_TAG_LENGTH = "</json>".length;
// JSON whitespace, then a character that can open a JSON value. The closing
// tag's `<` ends the match, so it never reads past the candidate's inner text.
const JSON_START_RE = /[ \t\n\r]*[-0-9"[{tfn]/y;
const QUOTE = 0x22;
const SLASH = 0x2f;
const LESS_THAN = 0x3c;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
/**
 * Most candidates one scan may reject. A rejection sends the scan back to just
 * after the candidate's opener, so each one can cost a pass over the rest of
 * the text; the cap keeps a scan linear. The candidate that reaches it stops
 * the scan. Only crafted text gets that far, but a block after it may be
 * someone else's, such as state an extension appended, so callers fail
 * closed: a message pass leaves the whole message as written, and the healer
 * leaves the rest as written.
 */
const MAX_REJECTED_CANDIDATES = 256;

/**
 * Every valid block in `text`, in order, inside macro tags or not, as
 * `{{jsonBlock}}` reads stored text. Text past the rejection cap is ignored.
 */
export function findJsonBlocks(text: string): JsonBlock[] {
  return scanJsonBlocks(text, false).blocks;
}

/**
 * The valid blocks in a message's own text: those outside every macro tag. A
 * block inside one, as in `{{setchatvar::state::<json>…</json>}}`, belongs to
 * the macro and stays ordinary text. A scoped body, as in
 * `{{setchatvar::state}}<json>…</json>{{/setchatvar}}`, is outside every tag.
 * The text from `stoppedAt` on must stay as written too.
 */
export function findTopLevelJsonBlocks(text: string): JsonBlockScan {
  return scanJsonBlocks(text, true);
}

/**
 * From a `<json>`, the scan follows JSON strings (quotes and backslash
 * escapes) to the first `</json>` outside one. A valid candidate is a block,
 * and the scan goes on after its closer. A `<json>` outside a string ends the
 * candidate unparsed, since JSON never has a `<` there, and the scan goes on
 * from that opener. An invalid candidate, or one with no closer, sends the
 * scan back to just after its opener, so a later opener inside one of its
 * strings can still start a block.
 *
 * With `topLevel`, an opener inside a macro tag starts no candidate. The lexer
 * reads it as the tag's text, so the scan counts tags through it and looks
 * for openers in it as in any other text; only the blocks it finds are
 * skipped, since protection keeps them from the lexer.
 */
function scanJsonBlocks(text: string, topLevel: boolean): JsonBlockScan {
  const blocks: JsonBlock[] = [];
  let rejected = 0;
  // Macro tag nesting at `counted`, for `topLevel`.
  let depth = 0;
  let counted = 0;
  let open = indexOfOpenTag(text, 0);
  while (open >= 0) {
    const innerStart = open + OPEN_TAG_LENGTH;
    if (topLevel) {
      depth = macroDepthAt(text, counted, open, depth);
      if (depth < 0) return { blocks: [], stoppedAt: 0 };
      counted = open;
      if (depth > 0) {
        open = indexOfOpenTag(text, innerStart);
        continue;
      }
    }
    const tag = indexOfTagOutsideStrings(text, innerStart);
    if (tag >= 0 && text.charCodeAt(tag + 1) !== SLASH) {
      open = tag;
      continue;
    }
    const block = tag >= 0 ? readBlock(text, open, tag) : undefined;
    if (block) {
      blocks.push(block);
      counted = block.end;
      open = indexOfOpenTag(text, block.end);
    } else if (++rejected === MAX_REJECTED_CANDIDATES) {
      return { blocks, stoppedAt: open };
    } else {
      open = indexOfOpenTag(text, innerStart);
    }
  }
  return { blocks, stoppedAt: text.length };
}

function indexOfOpenTag(text: string, from: number): number {
  OPEN_TAG_RE.lastIndex = from;
  return OPEN_TAG_RE.test(text) ? OPEN_TAG_RE.lastIndex - OPEN_TAG_LENGTH : -1;
}

/** Offset of the first `<json>` or `</json>` outside a JSON string, or -1. */
function indexOfTagOutsideStrings(text: string, from: number): number {
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (inString) {
      if (char === BACKSLASH) i++;
      else if (char === QUOTE) inString = false;
    } else if (char === QUOTE) {
      inString = true;
    } else if (char === LESS_THAN) {
      TAG_AT_RE.lastIndex = i;
      if (TAG_AT_RE.test(text)) return i;
    }
  }
  return -1;
}

/** The block from the opener at `start` to the closer at `close`, if the text between is JSON. */
function readBlock(text: string, start: number, close: number): JsonBlock | undefined {
  const innerStart = start + OPEN_TAG_LENGTH;
  // Text that cannot start JSON is no block, and telling needs no parse.
  JSON_START_RE.lastIndex = innerStart;
  if (!JSON_START_RE.test(text)) return undefined;
  const inner = text.slice(innerStart, close);
  let value: unknown;
  try {
    value = JSON.parse(inner);
  } catch {
    return undefined;
  }
  const end = close + CLOSE_TAG_LENGTH;
  return { start, end, source: text.slice(start, end), inner, value };
}

/**
 * Macro tag nesting at `to`, given `depth` at `from`, read as the macro lexer
 * reads text: `\{` and `\}` are literal braces, `{{` opens a tag, and `}}`
 * closes one; outside every tag, `}}` is plain text. No pair spans either
 * end: each is the text's start, an opener's `<`, or just past a block's `>`.
 */
function macroDepthAt(text: string, from: number, to: number, depth: number): number {
  for (let i = from; i < to; i++) {
    const char = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (char === BACKSLASH && (next === OPEN_BRACE || next === CLOSE_BRACE)) {
      i++;
    } else if (char === OPEN_BRACE && next === OPEN_BRACE) {
      if (malformedShorthandAt(text, i, to)) return -1;
      depth++;
      i++;
    } else if (char === CLOSE_BRACE && next === CLOSE_BRACE && depth > 0) {
      depth--;
      i++;
    }
  }
  return depth;
}

// A placeholder is a NUL, an id, and a NUL. The id is a random 20-digit nonce
// for the protection, then the block's index in it. Case transforms such as
// {{upper}} leave it alone, and it holds no brace, `<`, quote, `*`, `:`, or
// whitespace, so neither the lexer, the legacy-tag rewrite, nor formatting
// healing can touch it. The nonce keeps message text from forging one.
// The closing NUL is a lookahead: a stray NUL and digits right before a
// placeholder must not consume the NUL that opens it.
const PLACEHOLDER_RE = /\x00(\d+)(?=\x00)/g;

/**
 * Block source by placeholder id, per evaluation. The key is `env.extra`:
 * macros see a proxy of the env but the same `extra` object, so a placeholder
 * resolves only within the env that made it, for as long as that env lives.
 */
interface DataSource {
  source: string;
  literalOutput?: string;
  storedOutput?: string;
}
const registries = new WeakMap<object, Map<string, DataSource>>();

/**
 * Swap each top-level block in `text` for a placeholder. A text whose block
 * scan reached the rejection cap is `capped`: the rest of it is unclassified,
 * and a scoped tag may span the stop, so no part of it can be held out alone.
 * It comes back as it is, and no macro pass may run over it.
 */
export function protectJsonBlocks(
  text: string,
  env: Pick<MacroEnv, "extra">,
): { text: string; capped: boolean; restore(output: string): string } {
  // Restoring covers every placeholder made on this env, so output that picked
  // up another protection's placeholder, through a variable a concurrent pass
  // set, comes back too. Macros may drop a placeholder or repeat it.
  const restore = (output: string) => resolveJsonBlockPlaceholders(output, env);
  const { blocks, stoppedAt } = findTopLevelJsonBlocks(text);
  const capped = stoppedAt < text.length;
  if (capped || blocks.length === 0) return { text, capped, restore };

  let sources = registries.get(env.extra);
  if (!sources) {
    sources = new Map();
    registries.set(env.extra, sources);
  }
  const [high, low] = crypto.getRandomValues(new Uint32Array(2));
  const nonce = String(high).padStart(10, "0") + String(low).padStart(10, "0");
  let protectedText = "";
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const id = nonce + i;
    sources.set(id, { source: block.source });
    protectedText += text.slice(cursor, block.start) + "\x00" + id + "\x00";
    cursor = block.end;
  }
  return { text: protectedText + text.slice(cursor), capped: false, restore };
}

/**
 * Swap every placeholder made on this env for its block as written.
 * Placeholders from another env, and forged ones, stay as they are.
 */
export function resolveJsonBlockPlaceholders(text: string, env: Pick<MacroEnv, "extra">): string {
  return replacePlaceholders(text, registries.get(env.extra), (entry) => entry.literalOutput ?? entry.source);
}

/** Captured data can be read by handlers without becoming executable template text. */
export function protectLiteralData(text: string, env: Pick<MacroEnv, "extra">): string {
  if (!text) return text;
  const protection = protectJsonBlocks(text, env);
  const shielded = shieldDataBraces(protection.text);
  let sources = registries.get(env.extra);
  if (!sources) {
    sources = new Map();
    registries.set(env.extra, sources);
  }
  const [high, low] = crypto.getRandomValues(new Uint32Array(2));
  const id = String(high).padStart(10, "0") + String(low).padStart(10, "0");
  sources.set(id, {
    source: text,
    literalOutput: protection.restore(shielded),
    storedOutput: replacePlaceholders(shielded, sources, (entry) => entry.storedOutput ?? shieldJsonStrings(entry.source)),
  });
  return "\x00" + id + "\x00";
}

/**
 * Macro input read as JSON text: placeholders for message blocks become the
 * blocks, so a scoped body such as
 * `{{setchatvarkey::state::stats}}<json>…</json>{{/setchatvarkey}}` in a
 * message reads the JSON, and then both brace encodings become braces
 * (`normalizeJsonInput`).
 */
export function readJsonInput(text: string, env: Pick<MacroEnv, "extra">): string {
  return normalizeJsonInput(replacePlaceholders(text, registries.get(env.extra), (entry) => entry.source));
}

function replacePlaceholders(
  text: string,
  sources: Map<string, DataSource> | undefined,
  replace: (source: DataSource) => string,
): string {
  if (!sources || !text.includes("\x00")) return text;
  let replaced = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(text)) !== null) {
    const source = sources.get(match[1]);
    // An unknown match ends at its closing NUL, which may open the next one.
    if (source === undefined) continue;
    replaced += text.slice(cursor, match.index) + replace(source);
    cursor = PLACEHOLDER_RE.lastIndex + 1;
    PLACEHOLDER_RE.lastIndex = cursor;
  }
  return replaced + text.slice(cursor);
}

type ProtectedEnv = Pick<MacroEnv, "variables" | "_chatVarsDirty" | "extra">;
const VARIABLE_SCOPES = ["local", "chat", "global"] as const;

/**
 * Run one macro pass (evaluation and healing) over chat message content with
 * its top-level blocks held out. Placeholders in the pass output come back as
 * the blocks exactly as written. A variable a setter stored one in, as
 * `{{setchatvar::state}}<json>…</json>{{/setchatvar}}` does, gets the block as
 * inert JSON, so a later plain `{{getchatvar::state}}` cannot run macro text
 * from it. A variable name that took one from such a value in the same pass,
 * as `{{setchatvar::{{getchatvar::state}}::v}}` then does, gets the block
 * exactly as written, so no name keeps a placeholder. Both cover every
 * placeholder made on this env, including one a concurrent pass stored in a
 * variable this pass read. Content whose block scan reached the rejection cap
 * gets no pass and comes back exactly as written (see `protectJsonBlocks`).
 */
export async function withJsonBlocksProtected(
  content: string,
  env: ProtectedEnv,
  pass: (protectedContent: string) => Promise<string>,
): Promise<string> {
  const protection = protectJsonBlocks(content, env);
  if (protection.capped) return content;
  try {
    return protection.restore(await pass(protection.text));
  } finally {
    // No variable keeps a placeholder, even if the pass throws.
    restoreVariables(env);
  }
}

function restoreVariables(env: ProtectedEnv): void {
  const sources = registries.get(env.extra);
  if (!sources) return;
  for (const scope of VARIABLE_SCOPES) {
    const variables = env.variables[scope];
    // A restored name may add an entry, which this loop then meets with
    // nothing left to restore.
    for (const [name, value] of variables) {
      const key = replacePlaceholders(name, sources, (entry) => entry.source);
      // Stored chat state is untyped JSON, so a value is not always a string.
      const restored = typeof value === "string"
        ? replacePlaceholders(value, sources, (entry) => entry.storedOutput ?? shieldJsonStrings(entry.source))
        : value;
      if (key === name && restored === value) continue;
      if (key !== name) variables.delete(name);
      variables.set(key, restored);
      if (scope === "chat") env._chatVarsDirty = true;
    }
  }
}

/** Match the lexer's shorthand header; an uncertain early close fails closed. */
function malformedShorthandAt(text: string, start: number, to: number): boolean {
  const header = /^[ \t]*[!?~>/#]*[ \t]*[.@$]/.exec(text.slice(start + 2, to));
  if (!header) return false;
  let pos = start + 2 + header[0].length;
  while (pos < to && /[\w-]/.test(text[pos])) {
    if (text[pos] === "-" && (text[pos + 1] === "-" || text[pos + 1] === "=")) break;
    pos++;
  }
  while (pos < to && (text[pos] === " " || text[pos] === "\t")) pos++;
  const operator = text.slice(pos, pos + 2);
  if (["+=", "-=", "||", "??", "==", "!=", ">=", "<="].includes(operator) || ["=", ">", "<"].includes(text[pos])) return false;
  if (operator === "++" || operator === "--") {
    pos += 2;
    while (pos < to && (text[pos] === " " || text[pos] === "\t")) pos++;
  }
  return pos <= to && text.slice(pos, pos + 2) !== "}}";
}
