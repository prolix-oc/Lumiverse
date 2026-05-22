# Web Search

Lumiverse can plug a self-hosted **SearXNG** meta-search instance into the [Council](../council/index.md) so members can look up current, factual, or source-backed information mid-deliberation. Results are scraped, condensed into a context block, and handed back to the calling tool.

This is a host-level feature — once configured, any council member you assign the **Web Search** tool to can use it.

---

## How It Works

1. A council member calls the **Web Search** tool with a search-engine-style query.
2. Lumiverse forwards the query to your configured SearXNG instance.
3. The top results (up to your configured limit) are fetched and converted to clean text using the same scraper that powers [Databanks](../chatting/memory-cortex.md).
4. The combined snippets and page content are packaged into a single context block.
5. That context block is stored under the variable `web_search_context` and exposed to the rest of the deliberation.

The whole flow stays on infrastructure you control — the only outbound call is to your SearXNG host. No third-party search API is contacted by Lumiverse directly.

---

## Setting Up SearXNG

Web Search needs a reachable SearXNG instance that returns JSON.

1. **Run SearXNG** somewhere Lumiverse can reach (a Docker container on the same host is the easiest path).
2. **Enable JSON output** in your SearXNG `settings.yml`:
    ```yaml
    search:
      formats:
        - html
        - json
    ```
3. **(Optional) Require an API key** by putting a reverse proxy in front of SearXNG that checks the `Authorization: Bearer …` header. Lumiverse sends the key you provide using this scheme.
4. Note your instance's base URL — for example `https://searxng.example.com` or `http://localhost:8080`.

!!! warning "Public SearXNG instances will rate-limit you"
    The community list at [searx.space](https://searx.space) is fine for testing, but instances there throttle quickly and may block the JSON endpoint entirely. For day-to-day use, run your own.

---

## Configuring Lumiverse

Open **Settings → Web Search**.

### Required Fields

| Field | What it does |
|-------|--------------|
| **Enable web search** | Master switch. While off, the Council `web_search` tool is hidden and the test button is the only thing that runs. |
| **Provider** | `SearXNG` is currently the only supported provider. |
| **API URL** | Your SearXNG base URL. Lumiverse automatically appends `/search` if you only give a host. |
| **API Key** | Optional. Sent as `Authorization: Bearer <key>` if set — useful when your instance sits behind an auth proxy. The label shows **(configured)** once a key is saved. |

### Search Tuning

| Field | Default | Range | What it does |
|-------|---------|-------|--------------|
| **Engines** | (empty) | up to 20 | Comma-separated SearXNG engine allowlist (`google, brave, duckduckgo`). Leave empty to use whatever your SearXNG instance has enabled by default. |
| **Language** | `all` | any SearXNG code | Result language filter. `all` accepts everything; `en-US`, `de`, `ja` etc. narrow it. |
| **Safe Search** | Moderate | Off / Moderate / Strict | Maps to SearXNG's `safesearch=0/1/2`. |
| **Timeout (ms)** | 15,000 | 5,000 – 120,000 | How long Lumiverse waits for both the search request and each page fetch before giving up. |
| **Default Results** | 3 | 1 – 10 | Result count used when the council member doesn't specify one. |
| **Max Results** | 5 | 1 – 20 | Hard cap on results, even if a tool asks for more. Must be ≥ Default Results. |
| **Pages to Scrape** | 3 | 1 – 10 | Of the search results, how many to actually fetch and extract text from. Smaller is faster; larger gives the model more material to work with. |
| **Chars per Page** | 3,000 | 500 – 20,000 | Per-page text cap applied after scraping. Keeps the context block from blowing past the chat context. |

### Saving & Testing

1. Fill in the fields, optionally paste a new API key.
2. Click **Save Web Search Settings**.
3. Enter a phrase in **Test Query** and click **Test Web Search**.

The test uses **whatever is currently in the form**, including any unsaved API key — so you can validate a setup change before committing it. A successful test reports how many results were retrieved and how many pages were extracted, and shows the resulting context block in the **Preview** pane.

---

## Using Web Search in the Council

Once Web Search is **enabled** and an **API URL** is configured, a new **Web Search** tool appears under the Context category in the [Council Tools](../council/council-tools.md) picker.

To use it:

1. Open the **Council** panel and select a member.
2. Check **Web Search** in the tool list.
3. That member can now decide to call Web Search during deliberation. The tool's planning guidance encourages it to use short, keyword-heavy search phrases ("latest OpenRouter pricing", "Tokyo weather today") rather than full sentences or roleplay narration.

The tool accepts two arguments:

| Argument | Required | Notes |
|----------|----------|-------|
| `query` | Yes | The search phrase. The model is prompted to produce a real search-engine query, not narration. |
| `result_count` | No | How many results to fetch. Clamped to your **Max Results** setting. Defaults to your **Default Results** when omitted. |

The tool stores its output in the deliberation under the variable `web_search_context`. Any downstream member can read that variable — though it does not appear in the deliberation transcript by default, to keep the context block from leaking into prose.

!!! note "Web Search is gated"
    The tool only shows up in the Council picker while Web Search is enabled **and** an API URL is set. Toggling it off again removes the tool from any member that had it assigned for the duration the gate is closed.

---

## Related: OpenRouter Web Plugin

OpenRouter connections have their own **Web Search** plugin that runs on the provider side — it asks OpenRouter to augment the LLM response with web results before returning. You'll find it under **Connections → (OpenRouter connection) → Plugins → Web Search**.

This plugin is independent of Lumiverse's SearXNG Web Search:

- **Lumiverse Web Search** runs on _your_ infrastructure and is used by Council members as a tool.
- **OpenRouter Web** is a provider-side feature that affects responses from that OpenRouter connection regardless of whether you've configured SearXNG.

You can use neither, either, or both.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| "SearXNG returned HTTP 403" on test | Your instance has JSON output disabled, or a fronting proxy is blocking unauthenticated requests. Set an **API Key** or relax the proxy rule. |
| "SearXNG returned HTTP 429" | Rate-limited. If you're testing against a public instance, switch to a self-hosted one. |
| Tool never gets called by the Council | The member needs the tool explicitly checked. The model also won't call it for questions it can answer from the current chat — that's by design. |
| Empty results despite a working query in your browser | Your engine allowlist is too narrow, or your SearXNG instance has those engines disabled. Clear the **Engines** field and retest. |
| Pages return as `Fetch note: …` instead of content | The page blocks scraping (bot protection, login walls, JS-only rendering). The snippet from SearXNG is still included. |

!!! tip "Loopback URLs are allowed"
    For Owner users, `http://localhost`, `127.0.0.1`, and private-range hosts are allowed as the Web Search API URL — Lumiverse's normal "no private IPs" guard is relaxed here so you can point at a SearXNG container running alongside it.
