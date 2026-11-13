import { parseHTML } from "linkedom";
import type { PushPayload } from "../types/push";

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tr", "ul",
]);
const OMIT_TAGS = new Set(["math", "noscript", "script", "style", "svg", "template"]);

function appendLineBreak(parts: string[]): void {
  if (parts.length === 0 || parts[parts.length - 1]?.endsWith("\n")) return;
  parts.push("\n");
}

function appendNodeText(node: any, parts: string[]): void {
  if (node?.nodeType === 3) {
    parts.push(node.nodeValue ?? "");
    return;
  }
  if (node?.nodeType !== 1) return;

  const tag = String(node.localName ?? node.nodeName ?? "").toLowerCase();
  if (OMIT_TAGS.has(tag)) return;
  if (tag === "br" || tag === "hr") {
    appendLineBreak(parts);
    return;
  }

  const block = BLOCK_TAGS.has(tag);
  if (block) appendLineBreak(parts);
  if (tag === "img") {
    const alt = node.getAttribute?.("alt");
    if (alt) parts.push(alt);
  }
  for (const child of node.childNodes ?? []) appendNodeText(child, parts);
  if (block) appendLineBreak(parts);
}

function htmlToPlainText(value: string): string {
  try {
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    document.body.innerHTML = value;
    const parts: string[] = [];
    for (const child of document.body.childNodes) appendNodeText(child, parts);
    return parts.join("");
  } catch {
    return value.replace(/<[^>]*>/g, " ");
  }
}

function truncateNotificationText(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

export function notificationPlainText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || maxLength <= 0) return "";
  const plain = htmlToPlainText(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncateNotificationText(plain, maxLength);
}

export function normalizePushNotificationPayload(payload: PushPayload): PushPayload {
  return {
    ...payload,
    title: notificationPlainText(payload.title, 100) || "Lumiverse",
    body: notificationPlainText(payload.body, 500),
  };
}
