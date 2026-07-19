---
title: Supported Providers
---

# Supported Providers

Lumiverse supports 21 AI providers out of the box. Each provider has its own model catalog, API format, and capabilities.

---

## Provider List

| Provider | API Key Required | Notes |
|----------|:---:|-------|
| **OpenAI** | Yes | GPT-5.x, o-series, and more |
| **Anthropic** | Yes | Claude Opus, Sonnet, Haiku — includes Lumiverse-side prompt caching support |
| **Google** | Yes | Gemini Pro, Gemini Flash, and more |
| **Google Vertex AI** | Service account JSON | Enterprise Gemini access through Vertex. Paste the service account JSON into the API Key field; pick a region in the metadata. |
| **OpenRouter** | Yes (or OAuth) | Aggregator — access hundreds of models through one key. Supports OAuth sign-in and provider plugins. |
| **DeepSeek** | Yes | DeepSeek models with reasoning |
| **xAI** | Yes | Grok models |
| **Mistral** | Yes | Mistral and Mixtral models |
| **Groq** | Yes | Fast inference for open models |
| **Perplexity** | Yes | Search-augmented generation |
| **AI21** | Yes | Jamba models |
| **Moonshot** | Yes | Kimi models |
| **Fireworks** | Yes | Fast inference for open models |
| **ElectronHub** | Yes | Model aggregator |
| **SiliconFlow** | Yes | Chinese and international models |
| **NanoGPT** | Yes | Pay-per-token aggregator (shows subscription usage in the connection card) |
| **Infermatic** | Yes | TotalGPT — uncensored open-weights hosting (`https://api.totalgpt.ai/v1`) |
| **Chutes** | Yes | Model hosting platform |
| **Z.AI** | Yes | Standard and Coding Plan endpoints |
| **Pollinations** | No | Free text models, no API key required |
| **Custom** | Varies | Any OpenAI-compatible API endpoint |

---

## Custom Base URLs & Reverse Proxies

Every provider in Lumiverse lets you override the default **API URL** on each connection. This means any provider type can be pointed at a reverse proxy, load balancer, or alternative endpoint — not just the Custom provider.

For example, you could create an **OpenAI** connection but set its API URL to your proxy at `https://my-proxy.example.com/v1`. Lumiverse uses OpenAI's API format for the request but sends it to your custom URL.

This is useful for:

- **Reverse proxies** — Route requests through a proxy for logging, rate limiting, or cost tracking
- **Regional endpoints** — Use a provider's regional API endpoint instead of the default
- **Self-hosted mirrors** — Point to your own deployment of an API-compatible service

---

## Using the Custom Provider

The **Custom** provider is for services that aren't covered by the built-in providers but implement the OpenAI-compatible API format. This includes:

- **Local models** — LM Studio, Ollama, text-generation-webui, KoboldCpp
- **Other services** — Any endpoint with an OpenAI-compatible chat completions API

To use a custom provider:

1. Create a connection with provider set to **Custom**
2. Enter the **API URL** (e.g., `http://localhost:5000/v1` for a local model)
3. Enter the **Model** name as the server expects it
4. Add an **API Key** if the server requires one

---

## OpenRouter

**OpenRouter** is a popular choice because it gives you access to hundreds of models from many providers through a single API key:

1. Get an API key from [openrouter.ai](https://openrouter.ai), **or** click **Sign in with OpenRouter** on the connection form to do a PKCE OAuth flow that auto-fills the key.
2. Create a connection with provider set to **OpenRouter**.
3. Use the **Models** button to browse available models.

The OpenRouter connection form has two extra sections beyond the basics:

| Section | What it does |
|---------|--------------|
| **Routing** | Override OpenRouter's defaults — sort order (cheapest / fastest / lowest latency), provider allow/deny lists, quantization filters, and a data-collection mode (Allow / Deny). Useful when you want privacy-first routing or a specific upstream. |
| **Plugins** | Toggle OpenRouter-side features for this connection: **Web Search** (provider-side search augmentation, distinct from [Lumiverse Web Search](../settings/web-search.md)), **Response Healing** (auto-fixes malformed JSON on non-streaming responses), and **Context Compression** (middle-out compression when prompts exceed the model's limit). |

The connection card also shows your live OpenRouter **credit balance** — handy as a usage gauge.

---

## Anthropic Prompt Caching

Anthropic connections expose a per-connection **prompt caching** panel. Caching lets Anthropic reuse identical request prefixes between calls — you pay a small write cost on the cached call and get cheaper, faster reads on every subsequent call until the cache expires.

### Settings

| Field | What it does |
|-------|--------------|
| **Enable Prompt Caching** | Master switch. When off, every request hits Anthropic without `cache_control`. |
| **Prompt Cache TTL** | How long Anthropic should hold the cached prefix. `5 minutes` is the default (cheapest writes). `1 hour` keeps the cache alive across slower follow-up flows but costs more on the first write. |
| **Use Automatic Caching** | Lets Anthropic place the cache breakpoint at the last eligible block automatically. Recommended for most setups. |
| **Cache Tools** | Explicit breakpoint that caches your tool/function definitions. Worth turning on when you ship a large tool catalogue that's stable across calls. |
| **Cache System Prompt** | Explicit breakpoint on the system message. Best when your preset's system block is long and rarely changes mid-chat. |
| **Cache Conversation Prefix** | Explicit breakpoint on the conversation history up to the last user turn. Useful for long chats where the history grows but the bulk of it stays identical between calls. |

Automatic and explicit breakpoints can be combined. If you enable caching without ticking any breakpoint, Lumiverse falls back to automatic mode so the toggle never produces an empty `cache_control`.

### When to Use Each Pattern

| Pattern | Best for |
|---------|----------|
| **Automatic only** (default) | Normal chat. Anthropic picks the optimal breakpoint for you and you don't have to reason about it. |
| **Automatic + Cache System Prompt** | Roleplay with a large preset / character card that's stable across the chat. Cuts repeated charges for the system block. |
| **Cache Tools + System + Messages** | Long agentic flows with tools where the entire prefix is reused for many short user turns. Maximises hit rate at the cost of more cache writes. |
| **5m TTL** | Active chat where messages arrive at least every few minutes. |
| **1h TTL** | Slower interactive use, or chats where you pause for long stretches between turns. Higher first-write cost is amortized across more reads. |

The connection card shows a compact summary (e.g. `Cache 5m • auto + system`) so you can verify the active configuration at a glance.

!!! tip "Caching pairs nicely with reasoning binds"
    A heavy reasoning model with prompt caching enabled keeps deep thinking affordable. Bind your high-reasoning Claude profile to the connection (see [Binding Reasoning Settings](setting-up.md#binding-reasoning-settings)) and turn on at least **Cache System Prompt** so the prefix isn't re-paid every reasoning hop.

!!! warning "Caching only helps when the prefix is byte-identical"
    A single character difference in the cached portion invalidates the cache. Macros that change on every call (timestamps, random values, etc.) will undermine system-prompt caching — keep volatile content out of cached blocks.

---

## Z.AI Coding Plan

Z.AI ships two API URLs that share the same authentication but route to different upstreams:

| Endpoint | Path | Used for |
|----------|------|----------|
| **General** (default) | `https://api.z.ai/api/paas/v4` | Pay-as-you-go API access tied to your Z.AI account. |
| **Coding Plan** | `https://api.z.ai/api/coding/paas/v4` | Subscription Coding Plan keys (Z.AI's flat-rate plan for IDE/agent use). |

On a Z.AI connection, toggle **Use Coding Plan Endpoint** to route through `/api/coding/paas/v4`. Leave it off for normal API keys. Lumiverse rewrites the base URL accordingly — you don't have to edit the API URL field by hand.

Z.AI does not expose an OpenAI-compatible `/models` endpoint, so Lumiverse ships a built-in model list (`glm-5.2`, `glm-5.1`, `glm-5-turbo`, `glm-5`, `glm-4.7` family, `glm-4.6`, `glm-4.5` family, `glm-4-32b-0414-128k`) and validates your key by sending a minimal `chat/completions` request rather than a model list call. This is what keeps Coding Plan keys working — they 404 the model list endpoint but accept chat requests fine.

!!! tip "Coding Plan keys reject /models"
    If you see "model list failed" errors on a freshly-saved Z.AI connection, you probably forgot to enable **Use Coding Plan Endpoint** — Lumiverse's chat-completion validation already handles this, but third-party tools that hit `/models` directly will fail.

---

## Google Vertex AI

Vertex AI is Google's enterprise Gemini endpoint. Lumiverse authenticates with a **service account JSON** rather than an API key.

1. Create a service account in your GCP project with the **Vertex AI User** role and download the JSON key.
2. Create a connection with provider set to **Google Vertex AI**.
3. Paste the **entire service account JSON** into the API Key field.
4. Pick a **Region** (e.g. `us-central1`, `europe-west4`) in the Vertex metadata section, or leave it on `global` for the global endpoint.
5. Use the **Models** button to populate the model list from your project.

Because Vertex routes by project + region, the API URL is derived automatically from your service account and region selection — there's nothing to fill in there yourself.

---

## NanoGPT Usage

NanoGPT connections show a **subscription usage** card directly on the connection profile, similar to the credits readout on OpenRouter. Use it to watch your remaining quota without leaving Lumiverse.

---

## Provider Capabilities

Not all providers support all features:

| Feature | Support |
|---------|---------|
| **Text generation** | All providers |
| **Streaming** | All providers |
| **Vision (image input)** | OpenAI, Anthropic, Google, and models that support it |
| **Audio input** | Select OpenAI models |
| **Function calling** | OpenAI, Anthropic, Google, and compatible providers |
| **Structured output** | Provider-dependent (see below) |

### Structured Output

Different providers handle structured output differently:

- **Google Gemini** — Pass `responseMimeType` and `responseSchema` in parameters
- **OpenAI-compatible** — Pass `response_format` in parameters
- **Anthropic** — Use tool definitions for structured output
