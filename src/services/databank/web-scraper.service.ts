/**
 * Web Scraper Service — Fetches web pages and wiki content for databank ingestion.
 *
 * Automatically detects MediaWiki-based sites (Wikipedia, Fandom, etc.) and uses
 * the MediaWiki API for clean text extraction. Falls back to Mozilla Readability
 * for standard web pages.
 *
 * Adapted from LoomBuilder's lib/web/ modules.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { safeFetch, SSRFError } from "../../utils/safe-fetch";

// ─── Types ────────────────────────────────────────────────────

export interface ScrapedContent {
  title: string;
  content: string;
  url: string;
  sourceType: "web" | "wiki";
  /** Original byte length of extracted content */
  contentLength: number;
  metadata: Record<string, unknown>;
}

export type ScrapeErrorType =
  | "network_error"
  | "timeout"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "parse_error"
  | "no_content"
  | "invalid_url"
  | "ssrf_blocked";

export class ScrapeError extends Error {
  constructor(
    message: string,
    public readonly type: ScrapeErrorType,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ScrapeError";
  }
}

// ─── Constants ────────────────────────────────────────────────

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT = 15000;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024; // 5MB

// ─── Public API ───────────────────────────────────────────────

/**
 * Scrape a URL and return clean text content.
 * Auto-detects wiki pages and uses the appropriate extraction method.
 */
export async function scrapeUrl(url: string): Promise<ScrapedContent> {
  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ScrapeError("Only HTTP and HTTPS URLs are supported", "invalid_url");
    }
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    throw new ScrapeError("Invalid URL format", "invalid_url");
  }

  // Detect wiki type
  const wikiInfo = detectWiki(parsed);

  if (wikiInfo) {
    return scrapeWikiPage(wikiInfo.wikiUrl, wikiInfo.pageTitle, url);
  }

  return scrapeWebPage(url);
}

// ─── Wiki Detection ───────────────────────────────────────────

interface WikiInfo {
  wikiUrl: string;
  pageTitle: string;
  wikiType: "wikipedia" | "fandom" | "generic";
}

function detectWiki(parsed: URL): WikiInfo | null {
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  // Wikipedia: en.wikipedia.org/wiki/Page_Title
  if (hostname.includes("wikipedia.org")) {
    const match = pathname.match(/\/wiki\/(.+)/);
    if (!match) return null;
    return {
      wikiUrl: `${parsed.protocol}//${hostname}`,
      pageTitle: decodeURIComponent(match[1].replace(/_/g, " ")),
      wikiType: "wikipedia",
    };
  }

  // Fandom / Wikia: gameofthrones.fandom.com/wiki/Page_Title
  if (hostname.includes(".fandom.com") || hostname.includes(".wikia.org") || hostname.includes(".wikia.com")) {
    const match = pathname.match(/\/wiki\/(.+)/);
    if (!match) return null;
    return {
      wikiUrl: `${parsed.protocol}//${hostname}`,
      pageTitle: decodeURIComponent(match[1].replace(/_/g, " ")),
      wikiType: "fandom",
    };
  }

  // Generic MediaWiki: *.wiki TLD or sites with /wiki/ path + known patterns
  if (hostname.endsWith(".wiki") || hostname.includes("wiki.") || hostname.includes(".gamepedia.com")) {
    // Try /wiki/Page pattern
    const wikiMatch = pathname.match(/\/wiki\/(.+)/);
    if (wikiMatch) {
      return {
        wikiUrl: `${parsed.protocol}//${hostname}`,
        pageTitle: decodeURIComponent(wikiMatch[1].replace(/_/g, " ")),
        wikiType: "generic",
      };
    }
    // .wiki TLD: direct /Page_Title path
    if (hostname.endsWith(".wiki") && pathname.length > 1) {
      return {
        wikiUrl: `${parsed.protocol}//${hostname}`,
        pageTitle: decodeURIComponent(pathname.slice(1).replace(/_/g, " ")),
        wikiType: "generic",
      };
    }
  }

  return null;
}

// ─── Wiki Scraping (MediaWiki API) ────────────────────────────

function getApiEndpoints(wikiUrl: string): string[] {
  const normalized = wikiUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (normalized.includes(".fandom.com") || normalized.includes(".wikia.org") || normalized.includes(".wikia.com")) {
    return [`https://${normalized}/api.php`];
  }
  if (normalized.includes("wikipedia.org")) {
    return [`https://${normalized}/w/api.php`];
  }
  return [`https://${normalized}/api.php`, `https://${normalized}/w/api.php`];
}

async function scrapeWikiPage(wikiUrl: string, pageTitle: string, originalUrl: string): Promise<ScrapedContent> {
  const apiEndpoints = getApiEndpoints(wikiUrl);
  let lastError: Error | null = null;

  for (const apiUrl of apiEndpoints) {
    try {
      // Try TextExtracts API first (cleanest output)
      const content = await fetchWithTextExtracts(apiUrl, pageTitle);
      if (content.trim()) {
        return {
          title: pageTitle,
          content: content.trim(),
          url: originalUrl,
          sourceType: "wiki",
          contentLength: content.length,
          metadata: { wikiUrl, apiUrl, method: "textextracts" },
        };
      }

      // Fallback to parse API
      const parseContent = await fetchWithParseApi(apiUrl, pageTitle);
      if (parseContent.trim()) {
        return {
          title: pageTitle,
          content: parseContent.trim(),
          url: originalUrl,
          sourceType: "wiki",
          contentLength: parseContent.length,
          metadata: { wikiUrl, apiUrl, method: "parse" },
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  // All wiki API attempts failed — fall back to standard web scraping
  console.warn(`[web-scraper] Wiki API failed for "${pageTitle}", falling back to Readability`);
  try {
    return scrapeWebPage(originalUrl);
  } catch {
    throw lastError || new ScrapeError("Failed to fetch wiki page", "network_error");
  }
}

async function fetchWithTextExtracts(apiUrl: string, pageTitle: string): Promise<string> {
  const url = new URL(apiUrl);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("titles", pageTitle);
  url.searchParams.set("prop", "extracts|info");
  url.searchParams.set("explaintext", "true");
  url.searchParams.set("exsectionformat", "plain");
  url.searchParams.set("origin", "*");

  const response = await safeFetch(url.toString(), {
    timeoutMs: DEFAULT_TIMEOUT,
    maxBytes: MAX_CONTENT_BYTES,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new ScrapeError(`Wiki API returned status ${response.status}`, "network_error", response.status);
  }

  const data = await response.json() as any;
  const pages = data.query?.pages;
  if (!pages) return "";

  const pageIds = Object.keys(pages);
  if (pageIds.length === 0) return "";

  const page = pages[pageIds[0]];
  if (page.missing !== undefined) {
    throw new ScrapeError(`Page "${pageTitle}" does not exist`, "not_found");
  }

  return page.extract || "";
}

async function fetchWithParseApi(apiUrl: string, pageTitle: string): Promise<string> {
  const url = new URL(apiUrl);
  url.searchParams.set("action", "parse");
  url.searchParams.set("format", "json");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("prop", "text");
  url.searchParams.set("disabletoc", "true");
  url.searchParams.set("disableeditsection", "true");
  url.searchParams.set("origin", "*");

  const response = await safeFetch(url.toString(), {
    timeoutMs: DEFAULT_TIMEOUT,
    maxBytes: MAX_CONTENT_BYTES,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new ScrapeError(`Wiki parse API returned status ${response.status}`, "network_error", response.status);
  }

  const data = await response.json() as any;
  if (data.error) {
    if (data.error.code === "missingtitle") {
      throw new ScrapeError(`Page "${pageTitle}" not found`, "not_found");
    }
    throw new ScrapeError(data.error.info || "Parse API error", "parse_error");
  }

  const html = data.parse?.text?.["*"] || "";
  return htmlToPlainText(html);
}

// ─── Standard Web Scraping (Readability) ──────────────────────

async function scrapeWebPage(url: string): Promise<ScrapedContent> {
  let response: Response;
  try {
    response = await safeFetch(url, {
      timeoutMs: DEFAULT_TIMEOUT,
      maxBytes: MAX_CONTENT_BYTES,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
  } catch (err) {
    if (err instanceof SSRFError) {
      throw new ScrapeError(err.message, "ssrf_blocked");
    }
    throw new ScrapeError(
      err instanceof Error ? err.message : "Network error",
      "network_error",
    );
  }

  if (!response.ok) {
    const type: ScrapeErrorType =
      response.status === 404 ? "not_found" :
      response.status === 403 ? "forbidden" :
      response.status === 429 ? "rate_limited" :
      "network_error";
    throw new ScrapeError(`HTTP error ${response.status}`, type, response.status);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new ScrapeError("Response is not HTML content", "parse_error");
  }

  const html = await response.text();

  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      throw new ScrapeError("Could not extract article content from page", "no_content");
    }

    // Strip HTML from article content to get plain text
    const textDom = new JSDOM(`<div>${article.content}</div>`);
    const rawText = textDom.window.document.body.textContent || "";
    const cleanText = cleanExtractedText(rawText);

    if (!cleanText.trim()) {
      throw new ScrapeError("Extracted content is empty", "no_content");
    }

    return {
      title: article.title || new URL(url).hostname,
      content: cleanText,
      url,
      sourceType: "web",
      contentLength: cleanText.length,
      metadata: {
        byline: article.byline || null,
        excerpt: article.excerpt || null,
      },
    };
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    throw new ScrapeError("Failed to parse page content", "parse_error");
  }
}

// ─── Utilities ────────────────────────────────────────────────

function htmlToPlainText(html: string): string {
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Remove reference citations like [1], [2]
  text = text.replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "");
  // Convert block elements to newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n");
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  // Clean whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n +/g, "\n");
  text = text.replace(/ +\n/g, "\n");
  return text.trim();
}

function cleanExtractedText(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/ +\n/g, "\n")
    .trim();
}
