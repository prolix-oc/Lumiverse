import { safeFetch } from "../utils/safe-fetch";
import { mapWithConcurrency } from "../utils/concurrency";
import { scrapeUrl, type ScrapedContent } from "./databank";
import { getWebSearchApiKey, getWebSearchSettings, type WebSearchSettings } from "./web-search-settings.service";

// Pages are scraped through a small worker pool rather than serially: each
// scrapeUrl can take up to ~15s, so summing them on an interactive Council/
// Spindle path is the bottleneck. A pool of 4 overlaps them without fanning
// out an unbounded number of outbound requests.
const WEB_SEARCH_SCRAPE_CONCURRENCY = 4;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  score?: number;
}

export interface WebSearchDocument {
  title: string;
  url: string;
  snippet: string;
  sourceType?: ScrapedContent["sourceType"];
  content?: string;
  contentLength?: number;
  error?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  documents: WebSearchDocument[];
  context: string;
}

export interface WebSearchOptions {
  /** When false, skip page scraping. `documents` is returned empty and `context` is "". Defaults to true. */
  scrape?: boolean;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
}

interface ExaSearchResult {
  title?: string;
  url?: string;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaSearchResponse {
  results?: ExaSearchResult[];
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
  score?: number;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
}

function resolveSearchEndpoint(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/search";
  }
  return parsed.toString();
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeSearxngResult(row: SearxngResult): WebSearchResult | null {
  if (!row.url || typeof row.url !== "string") return null;
  const title = typeof row.title === "string" && row.title.trim()
    ? row.title.trim()
    : row.url;
  const snippet = typeof row.content === "string" ? row.content.trim() : "";
  return {
    title,
    url: row.url,
    snippet,
    ...(typeof row.engine === "string" && row.engine ? { engine: row.engine } : {}),
    ...(typeof row.score === "number" ? { score: row.score } : {}),
  };
}

function normalizeExaResult(row: ExaSearchResult): WebSearchResult | null {
  if (!row.url || typeof row.url !== "string") return null;
  const title = typeof row.title === "string" && row.title.trim()
    ? row.title.trim()
    : row.url;
  const highlight = Array.isArray(row.highlights)
    ? row.highlights.find((value): value is string => typeof value === "string" && !!value.trim())
    : undefined;
  const summary = typeof row.summary === "string" ? row.summary.trim() : "";
  const text = typeof row.text === "string" ? row.text.trim() : "";
  const snippet = highlight || summary || clipText(text, 500);
  return { title, url: row.url, snippet: snippet.trim() };
}

function normalizeTavilyResult(row: TavilySearchResult): WebSearchResult | null {
  if (!row.url || typeof row.url !== "string") return null;
  const title = typeof row.title === "string" && row.title.trim()
    ? row.title.trim()
    : row.url;
  const snippet = typeof row.content === "string" ? row.content.trim() : "";
  return {
    title,
    url: row.url,
    snippet,
    ...(typeof row.score === "number" ? { score: row.score } : {}),
  };
}

function buildContextBlock(query: string, documents: WebSearchDocument[], settings: WebSearchSettings): string {
  const lines = [
    `## Web Search Context`,
    `Query: ${query}`,
    "",
  ];

  if (documents.length === 0) {
    lines.push("No web results were retrieved.");
    return lines.join("\n");
  }

  documents.forEach((doc, index) => {
    lines.push(`${index + 1}. ${doc.title}`);
    lines.push(`URL: ${doc.url}`);
    if (doc.snippet) lines.push(`Snippet: ${doc.snippet}`);
    if (doc.content) {
      lines.push("");
      lines.push(clipText(doc.content, settings.maxCharsPerPage));
    } else if (doc.error) {
      lines.push(`Fetch note: ${doc.error}`);
    }
    lines.push("");
  });

  return lines.join("\n").trim();
}

async function fetchSearxngResults(
  query: string,
  requestedCount: number,
  settings: WebSearchSettings,
  apiKey: string | null,
): Promise<WebSearchResult[]> {
  if (!settings.apiUrl) {
    throw new Error("Web search API URL is not configured");
  }

  const endpoint = new URL(resolveSearchEndpoint(settings.apiUrl));
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("language", settings.language);
  endpoint.searchParams.set("safesearch", String(settings.safeSearch));

  const count = Math.min(requestedCount, settings.maxResultCount);
  endpoint.searchParams.set("count", String(count));
  if (settings.engines.length > 0) {
    endpoint.searchParams.set("engines", settings.engines.join(","));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await safeFetch(endpoint.toString(), {
    timeoutMs: settings.requestTimeoutMs,
    maxBytes: 2 * 1024 * 1024,
    headers,
    allowPrivate: true,
  });

  if (!response.ok) {
    throw new Error(`SearXNG returned HTTP ${response.status}`);
  }

  const payload = await response.json() as { results?: SearxngResult[] };
  const rows = Array.isArray(payload.results) ? payload.results : [];
  return rows
    .map(normalizeSearxngResult)
    .filter(Boolean)
    .slice(0, count) as WebSearchResult[];
}

async function fetchExaResults(
  query: string,
  requestedCount: number,
  settings: WebSearchSettings,
  apiKey: string | null,
  includeContent: boolean,
): Promise<{ results: WebSearchResult[]; documents: WebSearchDocument[] }> {
  if (!apiKey) {
    throw new Error("An Exa API key is required");
  }

  const count = Math.min(requestedCount, settings.maxResultCount);
  const response = await safeFetch(settings.apiUrl, {
    method: "POST",
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: count,
      ...(includeContent ? {
        contents: {
          // Exa limits maxCharacters to 10,000. The final context is still
          // clipped against Lumiverse's configured per-page limit below.
          text: { maxCharacters: Math.min(settings.maxCharsPerPage, 10_000) },
        },
      } : {}),
    }),
    timeoutMs: settings.requestTimeoutMs,
    maxBytes: 5 * 1024 * 1024,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Exa returned HTTP ${response.status}`);
  }

  const payload = await response.json() as ExaSearchResponse;
  const rows = Array.isArray(payload.results) ? payload.results : [];
  const results = rows
    .map(normalizeExaResult)
    .filter(Boolean)
    .slice(0, count) as WebSearchResult[];

  if (!includeContent) {
    return { results, documents: [] };
  }

  // Exa extracts content during search, avoiding Lumiverse's follow-up page
  // scraper. Preserve the existing maxPagesToScrape contract for context.
  const documents = rows
    .slice(0, settings.maxPagesToScrape)
    .map((row): WebSearchDocument | null => {
      const result = normalizeExaResult(row);
      if (!result) return null;
      const content = typeof row.text === "string" && row.text.trim()
        ? clipText(row.text.trim(), settings.maxCharsPerPage)
        : undefined;
      return {
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        ...(content ? { content, contentLength: row.text!.length } : {}),
      };
    })
    .filter(Boolean) as WebSearchDocument[];

  return { results, documents };
}

async function fetchTavilyResults(
  query: string,
  requestedCount: number,
  settings: WebSearchSettings,
  apiKey: string | null,
  includeContent: boolean,
): Promise<{ results: WebSearchResult[]; documents: WebSearchDocument[] }> {
  if (!apiKey) {
    throw new Error("A Tavily API key is required");
  }

  const count = Math.min(requestedCount, settings.maxResultCount);
  const response = await safeFetch(settings.apiUrl, {
    method: "POST",
    body: JSON.stringify({
      query,
      max_results: count,
      // Tavily's balanced, one-credit depth provides ranked snippets while
      // raw content below replaces Lumiverse's follow-up page scraper.
      search_depth: "basic",
      chunks_per_source: 3,
      include_answer: false,
      include_raw_content: includeContent ? "text" : false,
    }),
    timeoutMs: settings.requestTimeoutMs,
    maxBytes: 5 * 1024 * 1024,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Tavily returned HTTP ${response.status}`);
  }

  const payload = await response.json() as TavilySearchResponse;
  const rows = Array.isArray(payload.results) ? payload.results : [];
  const results = rows
    .map(normalizeTavilyResult)
    .filter(Boolean)
    .slice(0, count) as WebSearchResult[];

  if (!includeContent) {
    return { results, documents: [] };
  }

  // Tavily extracts the page during search, avoiding Lumiverse's follow-up
  // scraper. Fall back to its result snippet when raw content is unavailable.
  const documents = rows
    .slice(0, settings.maxPagesToScrape)
    .map((row): WebSearchDocument | null => {
      const result = normalizeTavilyResult(row);
      if (!result) return null;
      const source = typeof row.raw_content === "string" && row.raw_content.trim()
        ? row.raw_content.trim()
        : typeof row.content === "string" && row.content.trim()
          ? row.content.trim()
          : undefined;
      const content = source ? clipText(source, settings.maxCharsPerPage) : undefined;
      return {
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        ...(content ? { content, contentLength: source!.length } : {}),
      };
    })
    .filter(Boolean) as WebSearchDocument[];

  return { results, documents };
}

export async function searchWeb(
  userId: string,
  query: string,
  requestedCount?: number,
  options?: WebSearchOptions,
): Promise<WebSearchResponse> {
  const settings = await getWebSearchSettings(userId);
  const apiKey = await getWebSearchApiKey(userId, settings.provider);
  return searchWebWithConfig(query, requestedCount, settings, apiKey, options);
}

export async function searchWebWithConfig(
  query: string,
  requestedCount: number | undefined,
  settings: WebSearchSettings,
  apiKey: string | null,
  options?: WebSearchOptions,
): Promise<WebSearchResponse> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("Search query is required");
  }

  if (!settings.enabled) {
    throw new Error("Web search is disabled");
  }

  const count = Math.max(1, Math.min(requestedCount ?? settings.defaultResultCount, settings.maxResultCount));
  if (settings.provider === "exa") {
    const exa = await fetchExaResults(trimmedQuery, count, settings, apiKey, options?.scrape !== false);
    return {
      query: trimmedQuery,
      results: exa.results,
      documents: exa.documents,
      context: options?.scrape === false ? "" : buildContextBlock(trimmedQuery, exa.documents, settings),
    };
  }

  if (settings.provider === "tavily") {
    const tavily = await fetchTavilyResults(trimmedQuery, count, settings, apiKey, options?.scrape !== false);
    return {
      query: trimmedQuery,
      results: tavily.results,
      documents: tavily.documents,
      context: options?.scrape === false ? "" : buildContextBlock(trimmedQuery, tavily.documents, settings),
    };
  }

  const results = await fetchSearxngResults(trimmedQuery, count, settings, apiKey);

  if (options?.scrape === false) {
    return {
      query: trimmedQuery,
      results,
      documents: [],
      context: "",
    };
  }

  const scrapeCount = Math.min(results.length, settings.maxPagesToScrape);
  // Order is preserved by mapWithConcurrency, so documents stay aligned with
  // the ranked results. Per-page errors are captured per item (not thrown).
  const documents: WebSearchDocument[] = await mapWithConcurrency(
    results.slice(0, scrapeCount),
    WEB_SEARCH_SCRAPE_CONCURRENCY,
    async (result) => {
      try {
        const scraped = await scrapeUrl(result.url);
        return {
          title: scraped.title || result.title,
          url: result.url,
          snippet: result.snippet,
          sourceType: scraped.sourceType,
          content: clipText(scraped.content, settings.maxCharsPerPage),
          contentLength: scraped.contentLength,
        };
      } catch (err) {
        return {
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          error: err instanceof Error ? err.message : "Failed to extract page content",
        };
      }
    },
  );

  return {
    query: trimmedQuery,
    results,
    documents,
    context: buildContextBlock(trimmedQuery, documents, settings),
  };
}
