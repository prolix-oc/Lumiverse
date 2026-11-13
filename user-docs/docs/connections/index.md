---
title: Connections
---

# Connections

A **connection** links Lumiverse to an AI provider. The Connections drawer groups profiles by purpose: chat/LLM, embedding models, image generation, speech-to-text, text-to-speech, and decision models. Each profile specifies the provider, model, endpoint, and encrypted API key for that purpose.

Manage embedding profiles under **Embedding Models** in the Connections drawer, and select one in **Settings > Embeddings**. Keeping them separate prevents a chat model endpoint from being selected accidentally for vectorization. Existing direct embedding configurations and embedding profiles created from OpenAI-compatible chat connections are migrated automatically.

---

## Key Concepts

- **Provider** — The AI service (OpenAI, Anthropic, Google, etc.)
- **Model** — The specific model to use (e.g., GPT-4o, Claude Sonnet, Gemini Pro)
- **API Key** — Your authentication credential (stored encrypted)
- **API URL** — The endpoint URL (auto-filled for standard providers, customizable for self-hosted models)
- **Default Connection** — The connection used when no specific one is selected

---

## Folders and Search

Each connection type has its own folders. Use **New Folder** to add a folder. Rename it inline with the pencil beside its heading, or delete it with the trash button. Choose a folder when creating or editing a connection, then save the form. You can also drag a connection row or its handle onto a folder heading, including while searching. Connections without a folder appear in **Uncategorized**. Deleting a folder moves its connections to Uncategorized without deleting them.

Hold and drag a folder heading to change its order, including the position of Uncategorized. With a keyboard, focus the folder heading, press Space, use the arrow keys, then press Space to drop. Connection pickers use the same folder order. Folders and their order are saved to your account; you can organize inherited embedding connections without changing their configuration.

Search the Connections drawer by name, provider, model, or folder. Searching a folder name shows its connections, including those in collapsed folders. Clearing the search restores your previous expanded folders. Searching and collapsing folders preserve unsaved edits. Save or cancel an open connection edit before moving it or deleting its folder.

**Recently Used** offers shortcuts to the last four connections you selected within each type. These use the same connection rows and actions, remain in their original folders, and cannot be dragged. Connection pickers also show these shortcuts and let you search within that connection type.

---

## Quick Links

- [Setting Up a Connection](setting-up.md) — Step-by-step guide
- [Supported Providers](providers.md) — Full list of 21 supported providers
