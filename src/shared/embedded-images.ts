// Shared by the gallery importer and the editor's embedded-image count.
export const EMBEDDED_IMAGE_FIELDS = [
  "first_mes", "description", "personality", "scenario", "mes_example",
  "system_prompt", "post_history_instructions", "creator_notes",
  "alternate_greetings", "extensions",
] as const;

interface ImageSource {
  start: number;
  end: number;
  url: string;
}

function decodeHtmlUrl(url: string): string {
  return url.replace(/&(?:amp|#38|#x26);/gi, "&");
}

function imageSources(text: string): ImageSource[] {
  const sources: ImageSource[] = [];
  const add = (start: number, end: number, url: string) => {
    if (/^(?:https?:\/\/|data:image\/)/i.test(url)) sources.push({ start, end, url });
  };
  // Keep the URL separate from optional Markdown titles and angle brackets.
  const markdown = /!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>]+)>|((?:\([^()]*\)|[^()\s])+))(?:\s+["'][^"']*["'])?\s*\)/gd;
  const html = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gdi;
  const css = /\burl\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gdi;
  for (const [pattern, decode] of [[markdown, false], [html, true], [css, true]] as const) {
    for (const match of text.matchAll(pattern)) {
      const group = match.findIndex((value, index) => index > 0 && value !== undefined);
      const [start, end] = match.indices![group]!;
      const raw = match[group];
      add(start, end, decode ? decodeHtmlUrl(raw) : raw);
    }
  }

  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    const start = match.index!;
    // Embeds above already have exact boundaries (including URL punctuation).
    if (sources.some((source) => start >= source.start && start < source.end)) continue;
    let raw = match[0].replace(/[.,!?;:]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"]]) {
      while (raw.endsWith(close) && raw.split(close).length > raw.split(open).length) raw = raw.slice(0, -1);
    }
    const url = decodeHtmlUrl(raw);
    try {
      if (/\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|jfif|pjp|pjpeg|png|svg|webp)$/i.test(new URL(url).pathname)) {
        add(start, start + raw.length, url);
      }
    } catch { /* Ignore malformed URLs. */ }
  }
  return sources.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function extractImageUrls(text: string): string[] {
  return [...new Set(imageSources(text).map((source) => source.url))];
}

/** Replace complete image sources only; preserve titles, attributes and URL prefixes. */
export function replaceEmbeddedImageUrls(text: string, replacements: ReadonlyMap<string, string>): string {
  let cursor = 0;
  const output: string[] = [];
  for (const source of imageSources(text)) {
    if (source.start < cursor) continue;
    const replacement = replacements.get(source.url);
    if (replacement === undefined) continue;
    output.push(text.slice(cursor, source.start), replacement);
    cursor = source.end;
  }
  return output.length ? output.join("") + text.slice(cursor) : text;
}

/** Visit string values directly so JSON escaping cannot hide HTML attributes. */
export function mapEmbeddedImageText(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((entry) => mapEmbeddedImageText(entry, transform));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapEmbeddedImageText(entry, transform)]));
}

export function characterEmbeddedImageUrls(character: Partial<Record<typeof EMBEDDED_IMAGE_FIELDS[number], unknown>>): string[] {
  const urls = new Set<string>();
  for (const field of EMBEDDED_IMAGE_FIELDS) {
    mapEmbeddedImageText(character[field], (text) => {
      for (const url of extractImageUrls(text)) urls.add(url);
      return text;
    });
  }
  return [...urls];
}
