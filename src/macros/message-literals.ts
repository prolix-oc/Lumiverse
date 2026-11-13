import { createHash } from "node:crypto";
import type { Message } from "../types/message";
import { LITERAL_BRACE_CLOSE, LITERAL_BRACE_OPEN } from "./literal-braces";

const BRACE_RE = new RegExp(`${LITERAL_BRACE_OPEN}|${LITERAL_BRACE_CLOSE}`, "g");
const EXTRA_KEY = "macro_literal_braces";

export interface MessageLiteralContent {
  content: string;
  literalBraces: number[];
}

/** Decode for storage/display and remember which braces came from literal data. */
export function captureMessageLiterals(template: string): MessageLiteralContent {
  const literalBraces: number[] = [];
  let content = "";
  let cursor = 0;
  for (const match of template.matchAll(BRACE_RE)) {
    content += template.slice(cursor, match.index);
    literalBraces.push(content.length);
    content += match[0] === LITERAL_BRACE_OPEN ? "{" : "}";
    cursor = match.index! + match[0].length;
  }
  return { content: content + template.slice(cursor), literalBraces };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Content hashes preserve provenance across swipe navigation and deletion. */
export function shieldMessageLiterals(content: string, message: Pick<Message, "extra">): string {
  const entries = message.extra?.[EXTRA_KEY];
  if (!entries) return content;
  const positions = entries[contentHash(content)];
  if (!Array.isArray(positions)) return content;
  let protectedContent = "";
  let cursor = 0;
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < cursor || position >= content.length) return content;
    const brace = content[position];
    if (brace !== "{" && brace !== "}") return content;
    protectedContent += content.slice(cursor, position) + (brace === "{" ? LITERAL_BRACE_OPEN : LITERAL_BRACE_CLOSE);
    cursor = position + 1;
  }
  return protectedContent + content.slice(cursor);
}

/** Store provenance alongside canonical text without altering message content. */
export function withMessageLiteralExtra(
  extra: Message["extra"],
  rendered: MessageLiteralContent,
): Message["extra"] {
  if (rendered.literalBraces.length === 0 && !extra?.[EXTRA_KEY]) return extra;
  const entries = { ...extra?.[EXTRA_KEY] };
  if (rendered.literalBraces.length > 0) {
    entries[contentHash(rendered.content)] = rendered.literalBraces;
  } else {
    delete entries[contentHash(rendered.content)];
  }
  const updated = { ...extra };
  if (Object.keys(entries).length > 0) updated[EXTRA_KEY] = entries;
  else delete updated[EXTRA_KEY];
  return updated;
}
