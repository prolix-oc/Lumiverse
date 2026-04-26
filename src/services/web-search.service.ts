import { safeFetch } from "../utils/safe-fetch";
import { scrapeUrl, type ScrapedContent } from "./databank";
import { getWebSearchApiKey, getWebSearchSettings, type WebSearchSettings } from "./web-search-settings.service";

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

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
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

function normalizeResult(row: SearxngResult): WebSearchResult | null {
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
    .map(normalizeResult)
    .filter(Boolean)
    .slice(0, count) as WebSearchResult[];
}

export async function searchWeb(
  userId: string,
  query: string,
  requestedCount?: number,
): Promise<WebSearchResponse> {
  const settings = await getWebSearchSettings(userId);
  const apiKey = await getWebSearchApiKey(userId);
  return searchWebWithConfig(query, requestedCount, settings, apiKey);
}

export async function searchWebWithConfig(
  query: string,
  requestedCount: number | undefined,
  settings: WebSearchSettings,
  apiKey: string | null,
): Promise<WebSearchResponse> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("Search query is required");
  }

  if (!settings.enabled) {
    throw new Error("Web search is disabled");
  }

  const count = Math.max(1, Math.min(requestedCount ?? settings.defaultResultCount, settings.maxResultCount));
  const results = await fetchSearxngResults(trimmedQuery, count, settings, apiKey);

  const documents: WebSearchDocument[] = [];
  const scrapeCount = Math.min(results.length, settings.maxPagesToScrape);
  for (const result of results.slice(0, scrapeCount)) {
    try {
      const scraped = await scrapeUrl(result.url);
      documents.push({
        title: scraped.title || result.title,
        url: result.url,
        snippet: result.snippet,
        sourceType: scraped.sourceType,
        content: clipText(scraped.content, settings.maxCharsPerPage),
        contentLength: scraped.contentLength,
      });
    } catch (err) {
      documents.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        error: err instanceof Error ? err.message : "Failed to extract page content",
      });
    }
  }

  return {
    query: trimmedQuery,
    results,
    documents,
    context: buildContextBlock(trimmedQuery, documents, settings),
  };
}
