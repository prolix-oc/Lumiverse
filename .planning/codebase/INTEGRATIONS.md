# External Integrations

**Analysis Date:** 2026-08-17

## Executive Summary

Lumiverse integrates with an extensive ecosystem of external AI providers, local inference servers, vector databases, search engines, cloud storage backends, identity providers, and hardware controllers. Integrations follow unified driver interfaces with runtime fallback chains, client-side secret encryption via AES-256-GCM, and background workers for asynchronous tasks.

---

## LLM & AI Inference Providers

Lumiverse features a modular LLM provider registry (`src/llm/registry.ts`) implementing standard request formatting, Server-Sent Events (SSE) token streaming, reasoning/thinking extraction, prompt caching, and custom tool/grounding support.

| Provider | Driver File | Authentication | Key Features & Capabilities |
|---|---|---|---|
| **OpenAI** | `src/llm/providers/openai.ts` | API Key (Bearer) | GPT-4o, o1, o3-mini; SSE streaming; tool calling; reasoning effort levels |
| **Anthropic** | `src/llm/providers/anthropic.ts` | `x-api-key` header | Claude 3.5 Sonnet / Haiku / Opus; prompt caching (`cache_control`); extended thinking (`budget_tokens`) |
| **Google Gemini (AI Studio)** | `src/llm/providers/google.ts` | API Key (`x-goog-api-key` or query param) | Gemini 2.5 / 2.0 / 1.5 Pro / Flash; native Google Search Grounding (`src/llm/providers/google-search.ts`); safety thresholds |
| **Google Vertex AI** | `src/llm/providers/google-vertex.ts` | GCP Service Account JSON (OAuth2 Access Token) | Gemini on Google Cloud Vertex AI; regional endpoint selection (`us-central1`, `europe-west4`, etc.); automatic JWT token refreshes |
| **Amazon Bedrock** | `src/llm/providers/bedrock.ts` | AWS IAM Credentials (SigV4 signing) | Anthropic Claude, Meta Llama, Amazon Titan via AWS Bedrock; cross-region inference profile routing |
| **OpenRouter** | `src/llm/providers/openrouter.ts` | API Key (Bearer) | Multi-provider aggregation; model list fetching; prompt caching; fallback models |
| **DeepSeek** | `src/llm/providers/deepseek.ts` | API Key (Bearer) | DeepSeek-V3, DeepSeek-R1; reasoning extraction and thinking block parsing |
| **Groq** | `src/llm/providers/groq.ts` | API Key (Bearer) | Ultra-fast LPU inference (Llama 3.3, Qwen 2.5, DeepSeek R1-distill) |
| **Mistral AI** | `src/llm/providers/mistral.ts` | API Key (Bearer) | Mistral Large, Mistral Small, Codestral, Pixtral |
| **xAI (Grok)** | `src/llm/providers/xai.ts` | API Key (Bearer) | Grok 2, Grok Beta |
| **Perplexity AI** | `src/llm/providers/perplexity.ts` | API Key (Bearer) | Sonar search-grounded models with cited web sources |
| **Fireworks AI** | `src/llm/providers/fireworks.ts` | API Key (Bearer) | Serverless fast inference for open-weights models |
| **AI21 Labs** | `src/llm/providers/ai21.ts` | API Key (Bearer) | Jamba 1.5 Mini / Large (Mamba + Transformer hybrid architecture) |
| **Chutes** | `src/llm/providers/chutes.ts` | API Key (Bearer) | Decentralized GPU compute network for open-source LLMs |
| **NanoGPT** | `src/llm/providers/nanogpt.ts` | API Key (Bearer) | Pay-per-prompt crypto-funded inference; prompt caching support |
| **Moonshot (Kimi)** | `src/llm/providers/moonshot.ts` | API Key (Bearer) | Long-context Moonshot AI models |
| **ZAI (ZhiPu AI)** | `src/llm/providers/zai.ts` | API Key (Bearer) | GLM-4 and GLM-Zero models |
| **ElectronHub** | `src/llm/providers/electronhub.ts` | API Key (Bearer) | Multi-model proxy and aggregator |
| **SiliconFlow** | `src/llm/providers/siliconflow.ts` | API Key (Bearer) | High-throughput open-model hosting (Qwen, DeepSeek, GLM) |
| **Infermatic** | `src/llm/providers/infermatic.ts` | API Key (Bearer) | Curated uncensored and creative roleplay models |
| **Pollinations & Pollinations Text** | `src/llm/providers/pollinations.ts`, `src/llm/providers/pollinations-text.ts` | Free Tier / BYOP App Key (`pk_...`) | Free anonymous inference + optional publisher API key |
| **OpenAI-Compatible & Custom** | `src/llm/providers/openai-compatible.ts`, `src/llm/providers/custom.ts` | Optional API Key / Custom URL | Self-hosted local inference engines: **Ollama**, **vLLM**, **Aphrodite**, **TabbyAPI**, **KoboldCpp**, **LM Studio**, **Text Generation WebUI**, **llama.cpp**, **LocalAI** |

---

## Image Generation Providers

Lumiverse connects to remote image generation APIs and local WebUI workflows (`src/image-gen/registry.ts`):

| Provider | Driver File | Integration Mechanism | Supported Features |
|---|---|---|---|
| **ComfyUI** | `src/image-gen/providers/comfyui.ts`, `src/image-gen/providers/comfy-runner.ts` | REST API + WebSocket (`/ws`) | Node discovery (`/object_info`), workflow graph parsing and dynamic node patching (`src/image-gen/comfyui-workflow-patch.ts`), prompt queueing (`/prompt`), real-time execution progress tracking |
| **SwarmUI** | `src/image-gen/providers/swarmui.ts` | SwarmUI HTTP API | Direct SwarmUI backend integration with parameter translation |
| **Stable Diffusion WebUI (SD API)** | `src/image-gen/providers/sdapi.ts` | REST API (`/sdapi/v1/txt2img`, `/options`) | AUTOMATIC1111, SD.Next, and Forge backends; sampler selection, negative prompts, LoRA/checkpoint switching |
| **NovelAI** | `src/image-gen/providers/novelai.ts` | REST API (`/ai/generate-image`) | NovelAI Diffusion V3 / V4 (Curated / Anime); custom seeds, decoders, quality tags, and undesirable content presets |
| **Google Gemini (Imagen)** | `src/image-gen/providers/google-gemini.ts` | Gemini REST API | Imagen 3 and multimodal generation via Google AI Studio |
| **OpenAI (DALL-E)** | `src/image-gen/providers/openai.ts` | OpenAI `/v1/images/generations` | DALL-E 2 and DALL-E 3 with standard and HD quality modes |
| **OpenRouter Images** | `src/image-gen/providers/openrouter.ts` | OpenRouter REST API | FLUX and Stable Diffusion models routed via OpenRouter |
| **NanoGPT Images** | `src/image-gen/providers/nanogpt.ts` | NanoGPT REST API | Pay-per-generation FLUX and SDXL image synthesis |
| **Pollinations Image** | `src/image-gen/providers/pollinations.ts` | `https://image.pollinations.ai` | Zero-config instant image generation (FLUX, Turbo) with optional BYOP app key |

---

## Voice & Audio (TTS & STT)

### Text-to-Speech (TTS) Providers (`src/tts/registry.ts`)
- **Cartesia** (`src/tts/providers/cartesia.ts`): Sonic ultra-low latency voice synthesis via WebSocket and REST APIs.
- **ElevenLabs** (`src/tts/providers/elevenlabs.ts`): High-fidelity voice cloning, custom stability, similarity boost, and style sliders.
- **Kokoro TTS** (`src/tts/providers/kokoro.ts`): Lightweight, open-weight 82M parameter high-quality TTS engine running locally or remotely.
- **OpenAI TTS** (`src/tts/providers/openai-tts.ts`): `tts-1` and `tts-1-hd` models with standard voice presets (alloy, echo, fable, onyx, nova, shimmer).
- **OpenRouter TTS** (`src/tts/providers/openrouter-tts.ts`): Voice models routed via OpenRouter.
- **Qwen3 TTS Server** (`src/tts/providers/qwen3-tts-server.ts`, `src/tts/providers/qwen3-utils.ts`): Custom Qwen3-based voice synthesis endpoints.
- **OpenAI-Compatible Generic TTS** (`src/tts/providers/openai-compatible-tts.ts`): Custom endpoints implementing `/v1/audio/speech`.

### Speech-to-Text (STT) Integrations (`src/services/stt.service.ts`)
- **OpenAI Whisper & OpenAI-Compatible STT** (`src/services/stt-connections.service.ts`): Multipart audio file transcription with automatic language normalization (converts browser Web Speech locales e.g. `en-US` to ISO codes `en`).

---

## Vector Databases, Embedding Models & RAG

Lumiverse features a pluggable vector storage abstraction layer (`src/services/vector-store/`) allowing seamless transitions between embedded and distributed vector databases.

```
                  ┌───────────────────────────────────────────────┐
                  │          Vector Store Abstraction Layer        │
                  │        (src/services/vector-store/index.ts)   │
                  └──────┬────────────────┬───────────────┬───────┘
                         │                │               │
                         ▼                ▼               ▼
                  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐
                  │   LanceDB    │ │    Milvus    │ │   Qdrant    │
                  │  (Embedded)  │ │   (Remote)   │ │  (REST API) │
                  └──────────────┘ └──────────────┘ └─────────────┘
```

### Vector Database Backends
1. **LanceDB** (`src/services/vector-store/providers/lancedb.ts`):
   - Embedded columnar vector database (`@lancedb/lancedb` + `apache-arrow`).
   - Native disk persistence in `data/lancedb/`.
   - Supports Full-Text Search (FTS) indexes, scalar indexing, and IVF-PQ vector indexes.
   - Cross-process write synchronization for vectorization worker subprocesses (`LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK`).
2. **Milvus** (`src/services/vector-store/providers/milvus.ts`):
   - Distributed vector database via `@zilliz/milvus2-sdk-node`.
   - Supports user-partitioned collections, dynamic metadata schemas, and TLS encryption.
3. **Qdrant** (`src/services/vector-store/providers/qdrant.ts`):
   - Remote vector database integrated over REST API with payload filtering.

### Embedding Model Providers (`src/services/embeddings.service.ts`)
- **OpenAI**: `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`.
- **OpenRouter**: Aggregated embedding models.
- **ElectronHub**: Multi-provider embedding proxy.
- **BananaBread**: Local / containerized embedding server (`mixedbread-ai/mxbai-embed-large-v1`).
- **NanoGPT**: Pay-per-call text embeddings.
- **Google Vertex AI**: `gemini-embedding-001` via GCP OAuth2 tokens.
- **OpenAI-Compatible & Ollama**: Supports modern `/api/embed` batch requests and legacy `/api/embeddings` single-vector endpoints with automatic adaptive query chunk halving (`nextQueryEmbedLength`).

### Memory & Knowledge Retrieval Subsystems
- **Memory Cortex** (`src/services/memory-cortex/`): Advanced cognitive memory architecture with entity extraction, mention resolution, associative graph relations, salience decay, and dream consolidation.
- **Databank & Knowledge Base** (`src/services/databank/`): RAG document chunking (`document-chunker.service.ts`), fuzzy text search via `fuse.js`, and hybrid semantic ranking.
- **World Book Vector Retrieval**: Hybrid keyword matching combined with cosine similarity, Maximal Marginal Relevance (MMR), and Reciprocal Rank Fusion (RRF).

---

## Web Search & Scraping Integrations

Lumiverse allows assistants and Council tools to retrieve live information from the public internet:

### Search Engines
- **SearXNG** (`src/services/web-search.service.ts`, `src/services/web-search-settings.service.ts`):
  - Self-hosted or public SearXNG meta-search instance integration via JSON API (`/search?format=json`).
  - Configurable engine categories (general, news, science, it), language filtering, and safe-search levels (0, 1, 2).
  - Configured through Operator settings or user overrides.
- **Google Search Grounding** (`src/llm/providers/google-search.ts`):
  - Native Google Search grounding attached directly to Gemini 2.0 / 1.5 prompts.
  - Supports dynamic retrieval thresholds (`googleSearchDynamicThreshold`).

### Web Scraping & Ingestion
- **Readability & DOM Parser** (`src/services/databank/`, `@mozilla/readability`, `jsdom`):
  - Ingests URLs from user inputs, search results, or Databank imports.
  - Runs inside a concurrency-controlled worker pool (`WEB_SEARCH_SCRAPE_CONCURRENCY = 4`) using `src/utils/safe-fetch.ts` with Server-Side Request Forgery (SSRF) protections.

---

## Remote Filesystems & Storage Backends

Lumiverse features a unified filesystem provider abstraction (`src/file-connections/index.ts`) for importing character cards, world books, chat histories, and presets:

| Provider | Implementation File | Protocol / Library | Capabilities |
|---|---|---|---|
| **Local Filesystem** | `src/file-connections/providers/local.ts` | Node `node:fs/promises` | Native server filesystem access |
| **SFTP** | `src/file-connections/providers/sftp.ts` | `ssh2-sftp-client` | Remote SSH file transfer (opt-in via `LUMIVERSE_ENABLE_SFTP=1`) |
| **SMB / Windows Share** | `src/file-connections/providers/smb.ts` | Native SMB2 client | Network Attached Storage (NAS) and Windows CIFS shares |
| **Google Drive** | `src/file-connections/providers/google-drive.ts` | Google Drive REST API v3 | OAuth2 folder traversal and file downloads |
| **Dropbox** | `src/file-connections/providers/dropbox.ts` | Dropbox REST API v2 | OAuth2 file listing and content downloads |
| **SillyTavern Migrator**| `src/services/migration/`, `scripts/migrate-sillytavern.ts` | Filesystem / Remote FS | Automated parsing of SillyTavern character cards, lorebooks, user personas, and JSONL chat logs |

---

## Authentication, SSO & Web Push Notifications

### Internal Authentication
- **Better-Auth Engine** (`src/auth/index.ts`): SQLite-backed session store, Argon2/scrypt password hashing, admin role management, and signup nonce gating (`x-lumiverse-creation-nonce`).

### Single Sign-On (SSO) / OIDC Providers (`src/services/sso-providers.service.ts`)
- **Authelia**: Identity provider integration with OpenID Connect discovery.
- **Authentik**: Enterprise identity provider support with PKCE.
- **Keycloak**: Open-source IAM integration.
- **Custom OIDC**: Any OpenID Connect compliant provider with custom client ID, client secret, discovery URL, and redirect URIs.

### Web Push Notifications (`src/services/push.service.ts`)
- **VAPID Web Push**: Standard browser Push API notifications using `@pushforge/builder` and RFC 8291 / 8292 payload encryption.
- Automatically generates VAPID key pairs in `data/vapid.keys` and notifies users when long background generations or council tasks finish.

---

## Extensibility & Protocols

### Model Context Protocol (MCP) (`src/services/mcp-client-manager.ts`)
- **Host Role**: Lumiverse acts as an MCP host using `@modelcontextprotocol/sdk`.
- **Transports**: Supports both `stdio` (spawning local sub-processes) and `sse` (HTTP Server-Sent Events).
- **Security Policy** (`src/services/mcp-stdio-policy.ts`): Strict execution controls over spawned binaries, environment variable allowlists, and timeout policies.
- **Tool Exposure**: Discovered MCP tools are dynamically bridged into LLM tool-calling schemas and Council agent workflows.

### Spindle Extension Subsystem (`src/spindle/`)
- **Sandboxed Worker Runtime** (`src/spindle/worker-runtime.ts`): Isolated Worker threads and sub-processes running extension TypeScript/JavaScript.
- **RPC Protocol**: High-speed MessagePack / JSON RPC bridge connecting extensions to Host APIs (Content, State, Storage, Presentation, Image Gen, LLM Provider).
- **Git Updates** (`src/spindle/git-repository.ts`): Automatic remote Git repository tracking and in-place extension updating.

### Elgato Stream Deck Companion (`stream-deck/`)
- **Hardware Integration**: Dedicated Stream Deck plugin (`lumiverse-stream-deck`) communicating over local WebSocket connections.
- **Token Auth** (`src/routes/stream-deck.routes.ts`, `db/migrations/100_stream_deck_tokens.sql`): Authenticates hardware dials and buttons to trigger generation swipes, model switches, and status displays.

---

## Multiplayer & Community Services

### Lumiverse Multiplayer Identity & Relay (`src/multiplayer/`)
- **Attestation Server**: Connects to `https://mp-attest.lumiverse.chat` (configurable via `MPIDENTITY_URL`) for room registration and cryptographic attestation.
- **Relay Client** (`src/multiplayer/relay-client.ts`): Persistent outbound WebSocket relay client allowing users behind NAT/firewalls to participate in multiplayer chat rooms without port forwarding.
- **Attestation Tokens**: Cryptographically signed room tokens (`src/crypto/room-token.ts`) and MPID tokens for peer verification.

### LumiHub & LumiSpot Central Bridge (`src/lumihub/`)
- **Hub WebSocket Client** (`src/lumihub/client.ts`): Outbound WebSocket connection maintaining real-time links to LumiHub.
- **1-Click Installer Bridge**: Dispatches verified packages (character cards, prompt presets, CSS themes, lorebooks) directly from the browser community hub to the local instance.
- **Telemetry & Stats Sync**: Opt-in anonymous usage stats synchronization.

---

## Hardware Monitoring & Diagnostics

- **S.M.A.R.T. Disk Health Monitoring** (`src/services/smartctl.service.ts`):
  - Integrates with host `smartctl` (`smartmontools` package).
  - Collects disk temperature, power-on hours, reallocated sector counts, NVMe spare capacity, and critical failure warnings.
  - Automatically flags operational disk pressure and warnings in the Operator dashboard.

---

*Integration audit: 2026-08-17*
