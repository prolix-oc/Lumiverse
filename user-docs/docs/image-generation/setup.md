# Setup & Providers

Image generation uses its own connection profiles, separate from your LLM connections. You can have as many as you like and switch between them per chat.

---

## Creating an Image-Gen Connection

1. Open **Settings → Connections** (or the **Image Generation** panel and click the connection picker).
2. Add a new connection and choose the **Provider**.
3. Fill in the required fields for that provider (URL, API key, etc.).
4. Click **Test** to validate the connection.
5. Click **Models** (or the refresh button on the model picker) to populate the available model list. Models are fetched live where the provider supports it; otherwise a curated static list is used.
6. Optionally set **default parameters** (resolution, steps, CFG, sampler, …). These are stored on the connection and applied to every generation that uses it.
7. Save.

You can duplicate a connection to keep variant presets (for example, two SwarmUI connections that point at the same server but ship different default parameters).

!!! tip "API keys are encrypted at rest"
    Keys are stored in the Lumiverse identity vault (AES-256-GCM). They never leave your instance unless you opt into an [API Keys decryption ticket](../data-portability/api-keys-and-tickets.md) during data export.

---

## Provider-Specific Setup

### ComfyUI (local)

1. Run a ComfyUI server reachable from Lumiverse (default `http://localhost:8188`).
2. Create a ComfyUI connection in Lumiverse and point it at that URL.
3. Import a workflow — see [ComfyUI Workflows](#comfyui-workflows) below.

**Parameters exposed** at generation time: positive prompt, negative prompt, steps, CFG, sampler, scheduler, width, height, checkpoint, plus any custom fields you map.

**Streaming progress.** ComfyUI generations report step-by-step progress and live previews back into the panel.

### SwarmUI (local)

1. Run SwarmUI (default `http://localhost:7801`).
2. Create a SwarmUI connection. A session token is optional — the client refreshes sessions automatically (they expire every 30 minutes).
3. Pick a checkpoint. Models are scanned to a folder depth of 10, so nested layouts are supported.

**Parameters:** width/height (64–4096), steps (1–150), CFG (1–30), seed (-1 for random), sampler, scheduler, negative prompt, plus **component overrides** for VAE and text encoders (CLIP-L, CLIP-G, T5-XXL, Qwen, Mistral, Gemma, Llama). Lumiverse forces the SwarmUI aspect ratio to **Custom** so your explicit width/height are always respected.

**Streaming progress.** Like Comfy, SwarmUI generations stream progress and previews into the panel.

### Google Gemini

1. Add your Google AI Studio API key.
2. The model list is fetched from Google and filtered to image-capable models (with a static fallback when the API is unavailable).
3. Pick an **aspect ratio** (1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9) and an **image size** (1K / 2K / 4K).

### NovelAI

1. Add your NovelAI API key.
2. Choose a model from the six built-in options (V4.5 Full / Curated, V4 Full / Curated, Anime V3, Furry V3) — NovelAI does not expose a model-list endpoint.
3. Configure sampler (`k_euler_ancestral`, `k_euler`, `k_dpmpp_2m`, `k_dpmpp_2s_ancestral`, `k_dpmpp_sde`, `ddim_v3`), resolution, steps (1–50, default 28), guidance (1–20, default 5), and the SMEA / SMEA-DYN toggles.
4. NovelAI uses **Danbooru-style tags** instead of prose prompts; Lumiverse builds tag prompts automatically in Scene mode and includes character tags when **Include Characters and Persona** is on.

**Director references.** NovelAI can take up to 14 reference images per generation. Lumiverse can include the current character and/or persona avatar automatically, or you can upload your own. Each reference has its own strength, info-extracted, and fidelity sliders, plus a reference type. References are padded to the nearest supported canvas size (1024×1536, 1536×1024, or 1472×1472).

### NanoGPT

1. Add your NanoGPT API key.
2. The model list is fetched live with a static fallback (Flux variants, HiDream, DALL·E 3, Imagen 4, Midjourney, Recraft, SDXL, SD 3.5, Reve, and more).
3. Configure size (256², 512², 1024²), `numInferenceSteps`, `guidanceScale`, optional `strength` (for image-to-image when supported), and `seed`.

**Usage display.** NanoGPT shows your remaining credit/subscription usage in the connection panel, similar to OpenRouter.

### Pollinations

1. Add your Pollinations API key.
2. The model list is fetched live with a static fallback (`zimage`, `flux`, `gptimage`, `gptimage-large`, `kontext`, `nanobanana`, `seedream` variants, `qwen-image`).
3. Configure width/height (256–2048), `quality` (auto / low / medium / high), and the `enhance` and `transparent` toggles. Pollinations can return either base-64 or a URL; Lumiverse fetches whichever it gets.

---

## ComfyUI Workflows

ComfyUI doesn't have fixed parameters — your workflow defines what's adjustable. Lumiverse handles this with a **workflow import** step.

### Importing

1. In the ComfyUI panel of your connection, choose **Import workflow** and upload a workflow JSON (either the editor's "graph" format or the "API" format).
2. Lumiverse parses the graph and auto-detects the nodes that should receive standard parameters (positive prompt, negative prompt, sampler, steps, CFG, seed, width, height, checkpoint).
3. Review the detected **field mappings** — every parameter is shown alongside the node and field it routes to. Adjust mappings if Lumiverse picked the wrong node.
4. Save. The workflow JSON and your mappings live on the connection.

### Custom Fields

If your workflow has parameters that aren't in the standard set (for example, a LoRA strength or a custom sampler choice), expose them as **custom fields**. They appear in the panel's Advanced section and override the matching node value at generation time.

### Capabilities Discovery

The connection's **Capabilities** button queries the live ComfyUI server for available samplers, schedulers, and checkpoints. Use this whenever you add new models on the ComfyUI side so the panel pickers stay in sync.

---

## Connection Defaults vs. Live Parameters

Every numeric/select parameter shown in the panel can be set at three levels:

1. **Connection default** — set on the connection itself, applied to every generation.
2. **Panel override** — temporary, lives in the open Image Generation panel.
3. **Provider-level fallback** — the provider's own default if neither of the above is set.

Lower levels override higher ones, so anything you change in the panel only affects the current chat session unless you explicitly save it back to the connection.

---

## Migration From Legacy Settings

If you ran a previous version of Lumiverse that stored Gemini / NanoGPT / NovelAI keys in the global settings blob, those entries are migrated to encrypted connection profiles the first time you open the Image Generation panel. You don't need to do anything — the old keys disappear from settings and new connections appear in the picker.

---

## Tips

!!! tip "Test before saving defaults"
    Run a generation with a one-off panel value first; once you're happy with the result, copy it back to the connection's default parameters so future chats pick it up automatically.

!!! tip "Pre-warm slow connections"
    For ComfyUI / SwarmUI with large models, the first generation after a server restart can be slow while the checkpoint loads. Either bump the **Image Generation Timeout** (see [Scene, Output & Timeouts](scene-and-output.md)) or run a quick test from your server's UI first.

!!! warning "Local providers need network access"
    If Lumiverse is running in a container or VM, make sure the ComfyUI / SwarmUI URL is reachable from the Lumiverse process — not just from your browser.
