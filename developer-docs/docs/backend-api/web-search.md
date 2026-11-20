# Web Search

!!! warning "Permission required: `web_search`"
    This is a privileged permission. The user must explicitly grant it from the Extensions panel.

Execute searches via the user's configured web search provider (currently SearXNG; additional providers will be added over time) and read the safe view of their web search settings. Useful for grounding generations in fresh information, enriching chat context, or building RAG-style "look it up" workflows.

The host enforces all upstream limits — engine list, max result count, max pages to scrape, request timeout, language, and safesearch. Extensions cannot supply their own endpoint or API key; everything runs against the connection the user configured in **Settings → Web Search**.

## Usage

```ts
// Full enriched query — scrapes the top-N results and assembles a
// prompt-ready context block.
const result = await spindle.webSearch.query({
  query: 'latest LLM benchmark results',
  count: 5,
})

spindle.log.info(`Got ${result.results.length} results`)
spindle.log.info(result.context)   // ready to inject into a prompt
```

### Lightweight Query (No Scraping)

When you only need titles, URLs, and snippets — for autocomplete, link previews, or "did you mean" suggestions — pass `scrape: false` to skip the per-page fetch + extraction step entirely:

```ts
const quick = await spindle.webSearch.query({
  query: 'who won the 2026 world cup',
  scrape: false,
})

for (const row of quick.results) {
  spindle.log.info(`${row.title} — ${row.url}`)
}
// quick.documents and quick.context are omitted in this mode
```

This is significantly faster — no HTML fetch, no DOM extraction, no context-block assembly — and uses no upstream bandwidth beyond the search API call itself.

## Methods

### `spindle.webSearch.query(input)`

Run a search against the user's configured provider.

| Parameter | Type | Description |
|---|---|---|
| `input.query` | `string` | The search query. Trimmed by the host; empty values are rejected. |
| `input.count` | `number?` | Desired number of results. Clamped to `WebSearchSettingsDTO.maxResultCount` on the host. Omit to use the user's `defaultResultCount`. |
| `input.scrape` | `boolean?` | When `true` (default), scrapes up to `maxPagesToScrape` results and assembles a `context` block. When `false`, returns only the raw `results` array — `documents` and `context` are omitted from the response. |
| `input.userId` | `string?` | Target user (operator-scoped extensions only; user-scoped infers from the extension owner). |

**Returns:** `Promise<WebSearchResponseDTO>`

```ts
interface WebSearchResponseDTO {
  query: string                       // the (trimmed) executed query
  results: WebSearchResultDTO[]       // raw normalized results
  documents?: WebSearchDocumentDTO[]  // scraped page content (omitted when scrape: false)
  context?: string                    // prompt-ready context block (omitted when scrape: false)
}

interface WebSearchResultDTO {
  title: string
  url: string
  snippet: string
  engine?: string   // provider-reported engine, e.g. "google", "bing"
  score?: number    // provider-reported relevance score
}

interface WebSearchDocumentDTO {
  title: string
  url: string
  snippet: string
  sourceType?: string   // e.g. "html", "pdf"
  content?: string      // extracted page text, clipped to maxCharsPerPage
  contentLength?: number
  error?: string        // populated when scraping failed; content will be absent
}
```

**Throws:**

- `Error("Search query is required")` when `query` is empty after trimming.
- `Error("Web search is disabled")` when the user has not enabled web search in Settings.
- `Error("Web search API URL is not configured")` when the upstream endpoint is missing.
- `Error("SearXNG returned HTTP NNN")` (or equivalent for future providers) on upstream failures.
- `PERMISSION_DENIED: web_search — ...` when the permission has not been granted.

### `spindle.webSearch.getSettings(userId?)`

Read the safe view of the user's web search configuration. The raw API key is **never** exposed — only `hasApiKey` indicates whether one is on file.

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string?` | Target user (operator-scoped extensions only). |

**Returns:** `Promise<WebSearchSettingsDTO>`

```ts
interface WebSearchSettingsDTO {
  enabled: boolean
  provider: 'searxng'           // additional providers will be added over time
  apiUrl: string
  requestTimeoutMs: number
  defaultResultCount: number
  maxResultCount: number
  maxPagesToScrape: number
  maxCharsPerPage: number
  language: string              // e.g. "all", "en", "ja"
  safeSearch: 0 | 1 | 2         // 0=off, 1=moderate, 2=strict
  engines: string[]             // filtered engine list (empty = all)
  hasApiKey: boolean
}
```

## Checking Before Searching

Always confirm web search is configured before relying on it for critical workflows:

```ts
const settings = await spindle.webSearch.getSettings()

if (!settings.enabled) {
  spindle.toast.warning(
    'Configure a web search provider in Settings → Web Search to enable this feature.'
  )
  return
}

const result = await spindle.webSearch.query({ query: '...' })
```

You can also use the synchronous permission check up front:

```ts
if (!spindle.permissions.has('web_search')) {
  spindle.toast.warning(
    'Enable the "Web Search" permission in the Extensions panel to use this feature.'
  )
  return
}
```

## Attribution

Every search runs against the user's own configured provider and API key — extensions cannot redirect the query elsewhere. The host:

- Resolves the effective user from the extension scope (or from the explicit `userId` for operator-scoped extensions).
- Loads that user's `WebSearchSettings` and API key from the secure enclave.
- Enforces the user's `maxResultCount`, `maxPagesToScrape`, `maxCharsPerPage`, `requestTimeoutMs`, `language`, `safeSearch`, and `engines` filters.

Extensions never see the API key and cannot supply their own endpoint.

## Example: Grounding a Generation in Fresh Results

```ts
async function groundedReply(chatId: string, userQuestion: string) {
  // Pull up to 3 results and assemble the prompt-ready context block.
  const search = await spindle.webSearch.query({
    query: userQuestion,
    count: 3,
  })

  const result = await spindle.generate.quiet({
    messages: [
      {
        role: 'system',
        content: `Use the following web search context to answer the user. Cite source URLs.\n\n${search.context ?? '(no results)'}`,
      },
      { role: 'user', content: userQuestion },
    ],
  })

  await spindle.chat.appendMessage(chatId, {
    role: 'assistant',
    content: String((result as any)?.content ?? ''),
  })
}
```

## Example: Fast-Path Autocomplete

Skip scraping entirely when you only need link previews — the response comes back in a single upstream round-trip.

```ts
async function autocomplete(prefix: string): Promise<Array<{ label: string; url: string }>> {
  if (prefix.trim().length < 3) return []

  const quick = await spindle.webSearch.query({
    query: prefix,
    count: 8,
    scrape: false,
  })

  return quick.results.map((r) => ({ label: r.title, url: r.url }))
}
```

## Example: Tool-Driven Lookup

Register a Council-eligible tool that lets the model run a web search on demand:

```ts
spindle.registerTool({
  name: 'web_lookup',
  display_name: 'Web Lookup',
  description: 'Search the web and return short result snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms' },
      count: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
    },
    required: ['query'],
  },
  council_eligible: true,
  inline_available: true,
})

spindle.on('TOOL_INVOCATION', async (payload) => {
  if (payload.toolName !== 'web_lookup') return

  const { query, count = 3 } = payload.args as { query: string; count?: number }

  try {
    const search = await spindle.webSearch.query({ query, count, scrape: false })
    return search.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n')
  } catch (err) {
    if ((err as Error).message.startsWith('PERMISSION_DENIED:')) {
      return 'Web search permission not granted.'
    }
    if ((err as Error).message === 'Web search is disabled') {
      return 'Web search is not configured for this user.'
    }
    return `Search failed: ${(err as Error).message}`
  }
})
```

## Example: Bulk Reference Material

Combine `scrape: true` with `getSettings()` to discover the user's per-page cap before issuing a large query:

```ts
async function buildResearchBrief(topic: string): Promise<string> {
  const settings = await spindle.webSearch.getSettings()
  if (!settings.enabled) throw new Error('Web search disabled')

  const search = await spindle.webSearch.query({
    query: topic,
    count: settings.maxResultCount,   // request the user's allowed maximum
  })

  return [
    `# Research brief: ${topic}`,
    '',
    `Sources scraped: ${search.documents?.length ?? 0}`,
    `Per-page cap: ${settings.maxCharsPerPage.toLocaleString()} chars`,
    '',
    search.context ?? '(no results)',
  ].join('\n')
}
```

!!! tip "Best Practices"
    - Call `getSettings()` once at startup (or on `PERMISSION_CHANGED`) to cache the user's caps, rather than per-query.
    - Use `scrape: false` whenever you only need titles/URLs/snippets — it's faster and cheaper for both you and the user.
    - Wrap calls in a try/catch and degrade gracefully when web search is disabled, mis-configured, or upstream fails.
    - For tool-driven lookups, prefer `inline_available: true` so the model can chain searches inside a single generation.
    - Don't dump `result.context` into chat without framing — it's optimized for prompt injection, not for end-user reading.
