import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

export type WebPageParseErrorCode = "no_content" | "parse_error";

export interface ParsedWebPage {
  title: string;
  content: string;
  byline: string | null;
  excerpt: string | null;
}

export class WebPageParseError extends Error {
  constructor(
    message: string,
    public readonly code: WebPageParseErrorCode,
  ) {
    super(message);
    this.name = "WebPageParseError";
  }
}

function cleanExtractedText(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/ +\n/g, "\n")
    .trim();
}

/**
 * Parse an HTML document into readable plain text.
 *
 * This is deliberately isolated from the fetcher so it can run in a Worker:
 * JSDOM construction and Readability traversal are synchronous CPU work and
 * large pages can otherwise starve the server's WebSocket heartbeat handler.
 */
export function parseWebPage(html: string, url: string): ParsedWebPage {
  let dom: JSDOM | null = null;
  try {
    dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    if (!article) {
      throw new WebPageParseError(
        "Could not extract article content from page",
        "no_content",
      );
    }

    // Readability already provides plain text. Using it avoids constructing a
    // second JSDOM instance solely to read textContent from article.content.
    const content = cleanExtractedText(article.textContent || "");
    if (!content) {
      throw new WebPageParseError("Extracted content is empty", "no_content");
    }

    return {
      title: article.title || new URL(url).hostname,
      content,
      byline: article.byline || null,
      excerpt: article.excerpt || null,
    };
  } catch (err) {
    if (err instanceof WebPageParseError) throw err;
    throw new WebPageParseError("Failed to parse page content", "parse_error");
  } finally {
    dom?.window.close();
  }
}
