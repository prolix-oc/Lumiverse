import { describe, expect, mock, test } from "bun:test";

const calls: Array<{ url: string; options: Record<string, unknown> }> = [];

class MockSSRFError extends Error {}

mock.module("../utils/safe-fetch", () => ({
  SSRFError: MockSSRFError,
  safeFetch: async (url: string, options: Record<string, unknown>) => {
    calls.push({ url, options });
    if (url === "https://api.tavily.com/search") {
      return new Response(JSON.stringify({
        results: [{
          title: "Tavily result",
          url: "https://example.com/tavily",
          content: "Relevant Tavily snippet",
          raw_content: "Extracted Tavily content",
          score: 0.95,
        }],
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      results: [
        {
          title: "Exa result",
          url: "https://example.com/exa",
          text: "Extracted Exa content",
          highlights: ["Relevant Exa highlight"],
        },
      ],
    }), { headers: { "content-type": "application/json" } });
  },
}));

const { searchWebWithConfig } = await import("./web-search.service");
const {
  EXA_SEARCH_API_URL,
  TAVILY_SEARCH_API_URL,
  normalizeWebSearchSettings,
} = await import("./web-search-settings.service");

const exaSettings = {
  enabled: true,
  provider: "exa" as const,
  apiUrl: "https://api.exa.ai/search",
  requestTimeoutMs: 15_000,
  defaultResultCount: 3,
  maxResultCount: 5,
  maxPagesToScrape: 3,
  maxCharsPerPage: 3_000,
  language: "all",
  safeSearch: 1 as const,
  engines: [],
  hasApiKey: true,
  inlineToolEnabled: false,
};

describe("Exa web search provider", () => {
  test("uses Exa's fixed API endpoint when the provider is selected", () => {
    expect(normalizeWebSearchSettings({ provider: "exa", apiUrl: "https://stale-searxng.example" }, true)).toMatchObject({
      provider: "exa",
      apiUrl: EXA_SEARCH_API_URL,
      hasApiKey: true,
    });
  });

  test("requests extracted content and maps it into Lumiverse's response shape", async () => {
    calls.length = 0;

    const response = await searchWebWithConfig("exa search", 2, exaSettings, "exa-key");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.exa.ai/search",
      options: {
        method: "POST",
        headers: {
          "x-api-key": "exa-key",
          "Content-Type": "application/json",
        },
      },
    });
    expect(JSON.parse(String(calls[0].options.body))).toMatchObject({
      query: "exa search",
      numResults: 2,
      contents: { text: { maxCharacters: 3000 } },
    });
    expect(response).toMatchObject({
      query: "exa search",
      results: [{ title: "Exa result", url: "https://example.com/exa", snippet: "Relevant Exa highlight" }],
      documents: [{ content: "Extracted Exa content", contentLength: 21 }],
    });
    expect(response.context).toContain("Extracted Exa content");
  });

  test("skips Exa content extraction when scraping is disabled", async () => {
    calls.length = 0;

    const response = await searchWebWithConfig("exa search", 2, exaSettings, "exa-key", { scrape: false });

    expect(JSON.parse(String(calls[0].options.body))).not.toHaveProperty("contents");
    expect(response.documents).toEqual([]);
    expect(response.context).toBe("");
  });

  test("requires an API key", async () => {
    await expect(searchWebWithConfig("exa search", 2, exaSettings, null)).rejects.toThrow("Exa API key is required");
  });
});

const tavilySettings = {
  ...exaSettings,
  provider: "tavily" as const,
  apiUrl: TAVILY_SEARCH_API_URL,
};

describe("Tavily web search provider", () => {
  test("uses Tavily's fixed API endpoint when the provider is selected", () => {
    expect(normalizeWebSearchSettings({ provider: "tavily", apiUrl: "https://stale-searxng.example" }, true)).toMatchObject({
      provider: "tavily",
      apiUrl: TAVILY_SEARCH_API_URL,
      hasApiKey: true,
    });
  });

  test("uses Tavily's native extraction and maps it into Lumiverse's response shape", async () => {
    calls.length = 0;
    const response = await searchWebWithConfig("tavily search", 2, tavilySettings, "tavily-key");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: TAVILY_SEARCH_API_URL,
      options: {
        method: "POST",
        headers: {
          Authorization: "Bearer tavily-key",
          "Content-Type": "application/json",
        },
      },
    });
    expect(JSON.parse(String(calls[0].options.body))).toMatchObject({
      query: "tavily search",
      max_results: 2,
      search_depth: "basic",
      chunks_per_source: 3,
      include_raw_content: "text",
    });
    expect(response).toMatchObject({
      query: "tavily search",
      results: [{ title: "Tavily result", url: "https://example.com/tavily", snippet: "Relevant Tavily snippet", score: 0.95 }],
      documents: [{ content: "Extracted Tavily content", contentLength: 24 }],
    });
    expect(response.context).toContain("Extracted Tavily content");
  });

  test("skips Tavily raw-content extraction when scraping is disabled", async () => {
    calls.length = 0;
    const response = await searchWebWithConfig("tavily search", 2, tavilySettings, "tavily-key", { scrape: false });

    expect(JSON.parse(String(calls[0].options.body))).toMatchObject({ include_raw_content: false });
    expect(response.documents).toEqual([]);
    expect(response.context).toBe("");
  });

  test("requires an API key", async () => {
    await expect(searchWebWithConfig("tavily search", 2, tavilySettings, null)).rejects.toThrow("Tavily API key is required");
  });
});
