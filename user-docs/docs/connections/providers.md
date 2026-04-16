# Supported Providers

Lumiverse supports 19 AI providers out of the box. Each provider has its own model catalog, API format, and capabilities.

---

## Provider List

| Provider | API Key Required | Notes |
|----------|:---:|-------|
| **OpenAI** | Yes | GPT-5.x, o-series, and more |
| **Anthropic** | Yes | Claude Opus, Sonnet, Haiku |
| **Google** | Yes | Gemini Pro, Gemini Flash, and more |
| **OpenRouter** | Yes | Aggregator — access many models through one API key |
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
| **NanoGPT** | Yes | Pay-per-token aggregator |
| **Chutes** | Yes | Model hosting platform |
| **Z.AI** | Yes | Z.AI models |
| **Pollinations** | No | Free, no API key required |
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

1. Get an API key from [openrouter.ai](https://openrouter.ai)
2. Create a connection with provider set to **OpenRouter**
3. Set your API key
4. Use the **Models** button to browse available models

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
