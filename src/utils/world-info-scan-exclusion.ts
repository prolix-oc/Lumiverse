/**
 * Chat-message markup that hides text from World Info scanning while leaving
 * the stored, displayed, and model-visible message untouched:
 *
 * - `<wi-exclude>…</wi-exclude>`
 * - `!--WI_EXCLUDE_START--!` … `!--WI_EXCLUDE_END--!`
 * - any HTML element whose opening tag carries a `wi-exclude` attribute
 *
 * Only the text handed to keyword matching and the vector query changes.
 */

type Span = [start: number, end: number];

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  excluded: boolean;
  /** Index just past `>`, or -1 when the tag never closes. */
  end: number;
}

// Cheap gate so messages without the markup skip parsing entirely.
const EXCLUSION_HINT = /wi[-_]exclude/i;
const MARKER = /!--WI_EXCLUDE_(START|END)--!/g;
// Sticky patterns read one token at a known index, keeping the element scan
// forward-only (linear) on any input; each use sets lastIndex first.
const TAG_NAME = /\/?([a-zA-Z][\w:-]*)/y;
// One attribute as HTML tokenizes it: quotes delimit a value only after `=`,
// so a quoted `>` does not end the tag and `class = wi-exclude` is a value.
// Group 2 catches an opening quote that never closes.
const ATTRIBUTE = /[\s/]*(?:([^\s/>=][^\s/>=]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|(["'])|[^\s>]*))?)?/y;
const NON_WHITESPACE = /\S/;
// Tag names come from message text: look up with Object.hasOwn so names like
// "constructor" never resolve through Object.prototype.
const VOID_ELEMENTS: Record<string, true> = {
  area: true, base: true, br: true, col: true, embed: true, hr: true, img: true,
  input: true, link: true, meta: true, source: true, track: true, wbr: true,
};
// Bodies of these elements are raw text, so anything tag-like inside is inert.
const RAW_TEXT_END: Record<string, RegExp> = {
  iframe: /<\/iframe(?=[\s/>])/gi,
  noembed: /<\/noembed(?=[\s/>])/gi,
  noframes: /<\/noframes(?=[\s/>])/gi,
  noscript: /<\/noscript(?=[\s/>])/gi,
  script: /<\/script(?=[\s/>])/gi,
  style: /<\/style(?=[\s/>])/gi,
  textarea: /<\/textarea(?=[\s/>])/gi,
  title: /<\/title(?=[\s/>])/gi,
  xmp: /<\/xmp(?=[\s/>])/gi,
};

/** Marker regions nest by depth; an unclosed START runs to the end of the text. */
function findMarkerSpans(text: string): Span[] {
  const spans: Span[] = [];
  let depth = 0;
  let start = 0;
  for (const marker of text.matchAll(MARKER)) {
    if (marker[1] === "START") {
      if (depth++ === 0) start = marker.index;
    } else if (depth > 0 && --depth === 0) {
      spans.push([start, marker.index + marker[0].length]);
    }
  }
  if (depth > 0) spans.push([start, text.length]);
  return spans;
}

/**
 * Reads the tag opened by the `<` at `start`, or returns null when that `<`
 * does not open one. A tag that never closes (an unterminated quote, or no
 * `>` at all) owns the rest of the text, as in HTML.
 */
function readTag(text: string, start: number): Tag | null {
  TAG_NAME.lastIndex = start + 1;
  const name = TAG_NAME.exec(text);
  if (!name) return null;

  const tag: Tag = {
    name: name[1].toLowerCase(),
    closing: name[0].startsWith("/"),
    selfClosing: false,
    excluded: false,
    end: -1,
  };
  let index = TAG_NAME.lastIndex;
  for (;;) {
    ATTRIBUTE.lastIndex = index;
    const attribute = ATTRIBUTE.exec(text);
    if (!attribute) return tag;
    if (attribute[1]?.toLowerCase() === "wi-exclude") tag.excluded = true;
    if (attribute[2] !== undefined) return tag;
    index = ATTRIBUTE.lastIndex;
    if (index >= text.length) return tag;
    if (text[index] === ">") {
      // Only a bare `/` before `>` self-closes; in `href=/x/>` it belongs to the value.
      tag.selfClosing = attribute[1] === undefined && attribute[0].endsWith("/");
      tag.end = index + 1;
      return tag;
    }
    // A stray `=` matches nothing; step past it.
    if (attribute[0].length === 0) index++;
  }
}

/**
 * Excluded element spans. Nested same-name tags are matched by depth, and
 * comments and raw-text bodies are skipped so tag-like text inside them is
 * inert. Anything left unclosed owns the rest of the text, as in HTML.
 */
function findElementSpans(text: string): Span[] {
  const spans: Span[] = [];
  let open: { name: string; start: number; depth: number } | null = null;
  let cursor = text.indexOf("<");

  while (cursor !== -1) {
    if (text.startsWith("<!--", cursor)) {
      const close = text.indexOf("-->", cursor + 4);
      if (close === -1) break;
      cursor = text.indexOf("<", close + 3);
      continue;
    }

    const tag = readTag(text, cursor);
    if (tag === null) {
      cursor = text.indexOf("<", cursor + 1);
      continue;
    }

    if (open) {
      // Inside an excluded element only same-name tags matter, for nesting depth.
      if (tag.name === open.name && tag.end !== -1) {
        if (tag.closing) {
          if (--open.depth === 0) {
            spans.push([open.start, tag.end]);
            open = null;
          }
        } else if (!tag.selfClosing) {
          open.depth++;
        }
      }
    } else if (!tag.closing && (tag.name === "wi-exclude" || tag.excluded)) {
      if (tag.end !== -1 && (tag.selfClosing || Object.hasOwn(VOID_ELEMENTS, tag.name))) {
        spans.push([cursor, tag.end]);
      } else {
        open = { name: tag.name, start: cursor, depth: 1 };
      }
    }
    if (tag.end === -1) break;

    let next = tag.end;
    if (!tag.closing && !tag.selfClosing && Object.hasOwn(RAW_TEXT_END, tag.name)) {
      const rawTextEnd = RAW_TEXT_END[tag.name];
      rawTextEnd.lastIndex = tag.end;
      const close = rawTextEnd.exec(text);
      if (!close) break;
      next = close.index;
    }
    cursor = text.indexOf("<", next);
  }

  if (open) spans.push([open.start, text.length]);
  return spans;
}

/** Replaces each span with spaces of equal UTF-16 length. */
function blankSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    result += text.slice(cursor, start) + " ".repeat(end - start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

/**
 * Returns the text World Info should scan for one message. Excluded spans are
 * blanked with equal-length spaces (UTF-16 code units) so match offsets still
 * index the stored message and neighbouring words cannot fuse. Returns
 * `content` unchanged when nothing is excluded and `""` when nothing but
 * whitespace remains, so an entirely excluded message is not scanned.
 */
export function maskWorldInfoScanExclusions(content: string): string {
  if (!EXCLUSION_HINT.test(content)) return content;

  // Markers first so tags inside a marker region are inert.
  const unmarked = blankSpans(content, findMarkerSpans(content));
  const masked = blankSpans(unmarked, findElementSpans(unmarked));
  if (masked === content) return content;
  return NON_WHITESPACE.test(masked) ? masked : "";
}
