# Setting Up a Connection

This guide walks you through creating your first connection to an AI provider.

---

## Creating a Connection

1. Open the **Connection Manager** panel (plug icon)
2. Click **New Connection**
3. Fill in the fields:

### Required Fields

| Field | Description |
|-------|-------------|
| **Name** | A label for your reference (e.g., "Claude Sonnet 4.6," "GPT-5 Main") |
| **Provider** | Select your AI provider from the dropdown |

### Optional Fields

| Field | Description |
|-------|-------------|
| **Model** | The model to use — you can type it or select from the model list |
| **API URL** | Override the default endpoint (useful for proxies or self-hosted models) |
| **API Key** | Your provider's API key |
| **Preset** | A default preset to use with this connection |
| **Default** | Whether this is your primary connection |

4. Click **Save**

---

## Setting Your API Key

API keys are stored encrypted and never displayed after saving. To set or update a key:

1. Open the connection in the Connection Manager
2. Click **Set API Key** (or **Update API Key** if one already exists)
3. Paste your key
4. Save

The `has_api_key` indicator shows whether a key is stored without revealing the value.

!!! note "Per-connection keys"
    Each connection has its own API key. There's no shared "provider key" — this lets you use different keys for different connections to the same provider (e.g., separate keys for personal and work use).

---

## Testing Your Connection

After setting up a connection, verify it works:

1. Click the **Test** button on the connection
2. Lumiverse sends a simple request to your provider
3. You'll see either a success message or an error describing what went wrong

Common issues:

- **Invalid API key** — Double-check the key
- **Wrong API URL** — Make sure the endpoint matches your provider
- **Model not found** — Verify the model name is correct for your provider

---

## Listing Available Models

Click the **Models** button on a connection to fetch the list of models available with your API key. This queries your provider directly, so the list is always up to date.

---

## Multiple Connections

You can create as many connections as you want. Common setups:

- **Different providers** — One OpenAI connection, one Anthropic connection
- **Different models** — A fast model for casual chat, a powerful model for important scenes
- **Different keys** — Separate billing or quota management
- **Self-hosted** — A connection to your local LLM alongside cloud connections

Switch between connections by setting a different one as **default**, or select a specific connection when starting a generation.

---

## Sidecar Connection

Some features (expression detection, council tools, image gen scene analysis) use a separate **sidecar connection** — a lightweight model for background tasks. Configure the sidecar in **Settings > Advanced** or in the **Sidecar Settings** section.

The sidecar keeps background processing costs low by using a smaller, cheaper model for auxiliary tasks while your main connection handles the primary generation.

---

## Deleting a Connection

Deleting a connection also removes its stored API key from the encrypted secrets. This cannot be undone.
