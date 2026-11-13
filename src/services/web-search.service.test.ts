import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
const deepseekRow = {
  title: "DeepSeek result",
  url: "https://example.com/deepseek",
  snippet: "Short snippet",
  summary: "Long model-oriented summary",
  content: "Extracted DeepSeek content",
  rerank_score: 2.4,
  site_name: null,
  site_icon: null,
  date: null,
  authority: -1,
};
let deepseekPayload: unknown;
let deepseekStatus = 200;

beforeEach(() => {
  calls.length = 0;
  deepseekPayload = { results: [deepseekRow] };
  deepseekStatus = 200;
});

const realSafeFetch = await import("../utils/safe-fetch");

mock.module("../utils/safe-fetch", () => ({
  ...realSafeFetch,
  safeFetch: async (url: string, options: Record<string, unknown>) => {
    calls.push({ url, options });
    if (url === "https://api.deepseek.com/v1/tools/search") {
      return new Response(JSON.stringify(deepseekPayload), {
        status: deepseekStatus,
        headers: { "content-type": "application/json" },
      });
    }
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
  DEEPSEEK_SEARCH_API_URL,
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

const deepseekSettings = {
  ...exaSettings,
  provider: "deepseek" as const,
  apiUrl: DEEPSEEK_SEARCH_API_URL,
};

describe("DeepSeek web search provider", () => {
  test("uses the fixed official endpoint instead of a stale or supplied URL", () => {
    expect(normalizeWebSearchSettings({ provider: "deepseek", apiUrl: "https://stale.example" }, true)).toMatchObject({
      provider: "deepseek",
      apiUrl: DEEPSEEK_SEARCH_API_URL,
      hasApiKey: true,
    });
  });

  test("sends the documented request and maps native content without a follow-up fetch", async () => {
    const response = await searchWebWithConfig("  DeepSeek site:github.com lang:en  ", 2, deepseekSettings, "deepseek-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: DEEPSEEK_SEARCH_API_URL,
      options: {
        method: "POST",
        timeoutMs: 15_000,
        headers: { Authorization: "Bearer deepseek-key", "Content-Type": "application/json" },
      },
    });
    expect(calls[0].options).not.toHaveProperty("allowPrivate");
    expect(JSON.parse(String(calls[0].options.body))).toEqual({
      query: "DeepSeek site:github.com lang:en",
      count: 2,
      need_content: true,
    });
    expect(response).toMatchObject({
      query: "DeepSeek site:github.com lang:en",
      results: [{ title: deepseekRow.title, url: deepseekRow.url, snippet: deepseekRow.snippet, score: 2.4 }],
      documents: [{ content: deepseekRow.content, contentLength: deepseekRow.content.length }],
    });
    expect(response.context).toContain(deepseekRow.content);
  });

  test("skips content extraction and context in results-only searches", async () => {
    const response = await searchWebWithConfig("search", undefined, deepseekSettings, "key", { scrape: false });
    expect(JSON.parse(String(calls[0].options.body))).toEqual({ query: "search", count: 3, need_content: false });
    expect(response.results).toHaveLength(1);
    expect(response.documents).toEqual([]);
    expect(response.context).toBe("");
  });

  test("uses summaries then snippets when page content is unavailable", async () => {
    deepseekPayload = { results: [
      { ...deepseekRow, content: " " },
      { ...deepseekRow, title: " ", content: "", summary: "" },
    ] };
    const response = await searchWebWithConfig("search", 2, deepseekSettings, "key");
    expect(response.documents.map(doc => doc.content)).toEqual([deepseekRow.summary, deepseekRow.snippet]);
    expect(response.results[1].title).toBe(deepseekRow.url);
    expect(calls).toHaveLength(1);
  });

  test("bounds results and page content after discarding invalid rows", async () => {
    const content = "x".repeat(700);
    deepseekPayload = { results: [null, { title: "Missing URL" }, { ...deepseekRow, content }, deepseekRow, deepseekRow] };
    const response = await searchWebWithConfig("search", 10, {
      ...deepseekSettings, maxResultCount: 2, maxPagesToScrape: 1, maxCharsPerPage: 500,
    }, "key");
    expect(JSON.parse(String(calls[0].options.body)).count).toBe(2);
    expect(response.results).toHaveLength(2);
    expect(response.documents).toHaveLength(1);
    expect(response.documents[0].content).toHaveLength(500);
    expect(response.documents[0].contentLength).toBe(700);
    expect(response.context).not.toContain("x".repeat(501));
  });

  test.each([{ results: [] }, {}])("handles empty results: %j", async (payload) => {
    deepseekPayload = payload;
    const response = await searchWebWithConfig("search", 2, deepseekSettings, "key");
    expect(response.results).toEqual([]);
    expect(response.documents).toEqual([]);
    expect(response.context).toContain("No web results were retrieved.");
  });

  test("requires an API key before making a request", async () => {
    await expect(searchWebWithConfig("search", 2, deepseekSettings, null)).rejects.toThrow("DeepSeek API key is required");
    expect(calls).toHaveLength(0);
  });

  test("accepts 128 Unicode code points and rejects longer queries without truncating", async () => {
    const query = "🔍".repeat(128);
    await searchWebWithConfig(query, 2, deepseekSettings, "key");
    expect(JSON.parse(String(calls[0].options.body)).query).toBe(query);
    await expect(searchWebWithConfig(query + "a", 2, deepseekSettings, "key")).rejects.toThrow("at most 128 Unicode characters");
    expect(calls).toHaveLength(1);
  });

  test.each([400, 401, 402, 429, 504])("reports HTTP %i errors without echoing the response body", async (status) => {
    deepseekStatus = status;
    deepseekPayload = { error: { message: "private details" } };
    await expect(searchWebWithConfig("search", 2, deepseekSettings, "key")).rejects.toThrow(`DeepSeek returned HTTP ${status}`);
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
