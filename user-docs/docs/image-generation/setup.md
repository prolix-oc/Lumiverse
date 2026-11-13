---
title: Setup & Providers
---

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

## Generation Settings

Keep connection selection in the **Image Gen** drawer. Open **Configure Generation…** for deeper controls:

- **Generation** contains the provider’s main parameters, collapsed **Model Overrides**, and ComfyUI workflow status and custom mapped fields. Expand **Model Overrides** to change individual model components.
- **Sources** appears when the connection supports reference images, source images, or source-related schema parameters. Upload up to 14 reference images, remove them, or include character/persona avatars where supported. References are saved on the selected connection.
- **Automation** contains scene sensitivity, context limits, image recycling, gallery behavior, and background display when the output is Set as background.
- **Advanced** contains advanced parameters, additional provider groups, and the two generation timeouts.

The fields follow the selected provider’s capability schema. Switching connections updates the available controls. Parser settings are in **Prompt Studio**, and LoRA layers are in **LoRA Studio**.

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

**API URL.** Leave this field blank to use `https://image.novelai.net`, or enter your proxy's base URL (for example, `https://proxy.example`). Existing base URLs continue to work. Enter the base URL without a generation endpoint suffix.

**Non-streaming generation.** Enable **Use non-streaming generation** in the NovelAI connection profile if your proxy only supports `/ai/generate-image`. With the checkbox off (the default), Lumiverse uses `/ai/generate-image-stream`. The saved profile selects the route and payload before a single request; errors never trigger a retry on another endpoint, and toggling the checkbox leaves your saved base URL unchanged. This setting applies to chat, Weaver, and Spindle image generation. Both modes support PNG and ZIP image responses.

**Testing the connection.** The **Test** button checks `/user/information` on the configured base URL without generating an image, regardless of the generation mode. A proxy must expose this route for the test to succeed.

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

### OpenAI

1. Add your OpenAI API key.
2. The model list is fetched live with a static fallback (`gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`, `chatgpt-image-latest`, `dall-e-3`, `dall-e-2`).
3. When a source or reference image is supplied, Lumiverse routes the request to `/images/edits`; otherwise it uses `/images/generations`.

### Custom (OpenAI-compatible image)

Point at any host that exposes `POST {base}/images/generations` with the OpenAI Images request/response shape — Together AI, xAI, Venice's compatibility endpoint, Recraft, DeepInfra, LiteLLM, reverse proxies, or a self-hosted gateway.

1. Set the **API URL** to the provider's OpenAI-compatible base (for example `https://api.together.xyz/v1`).
2. Add the API key.
3. Pick or type a model id. The model list is fetched live from `{base}/models` and filtered to likely image models, with no static fallback.
4. Set `size`, optional `steps`, `seed`, and `negative_prompt`. Fields a given host does not understand are ignored by that host.

Responses are handled whether the provider returns `data[].url` or `data[].b64_json`; URL results are downloaded and stored immediately so they survive short-lived links.

### Together AI

1. API URL defaults to `https://api.together.xyz/v1`. Model list is fetched live and filtered to image families, with a static FLUX fallback.
2. Configure `size` (sent as `width`/`height`) **or** an `aspectRatio` (Schnell / Kontext models), plus `steps` and `seed`. Together's inline response format is `response_format: "base64"`, and it accepts a negative prompt.
3. With a source image, Lumiverse sends it as a data URL on `image_url` (FLUX.1 Kontext) or `reference_images` (FLUX.2, Gemini).

### xAI (Grok Imagine)

1. API URL defaults to `https://api.x.ai/v1`.
2. Models: `grok-imagine-image-2.0`, `grok-imagine-image`.
3. Configure an `aspectRatio` (plus an optional `resolution` tier) and, on `grok-imagine-image-2.0` generations, `quality`. With a source image, Lumiverse posts **JSON** to `/images/edits` with the image as a base64 data URL — one image uses `image`, several use `images[]` (up to five). xAI does not accept the OpenAI SDK's multipart edit call.

### Venice AI

Two connections are available:

- **Venice AI** uses the native `/image/generate` API — `negative_prompt`, explicit width/height **or** an `aspect_ratio` plus a `resolution` tier (1K / 2K / 4K), `style_preset` (valid names come from `GET /image/styles`), `format`, and `seed`. Results come back as base64.
- **Venice AI (OpenAI-compatible)** uses `/images/generations` for a simpler OpenAI-shaped surface.

Both default to `https://api.venice.ai/api/v1`.

### Recraft

1. API URL defaults to `https://external.api.recraft.ai/v1`.
2. Models: `recraftv4_1`, `recraftv4`, `recraftv4_pro`, `recraftv3`, `recraftv2`.
3. Configure `size`, optional `style` id, and `seed`. Lumiverse requests `b64_json` for a durable result. Vector (SVG) and raster sub-endpoints are reachable through the raw-request override.

### DeepInfra

1. API URL defaults to `https://api.deepinfra.com/v1/openai`.
2. DeepInfra returns `b64_json` only, so Lumiverse requests `response_format: "b64_json"`. Configure `size` and `seed`. LoRA adapters are reachable through the raw-request override.

### Ideogram

1. API URL defaults to `https://api.ideogram.ai`; auth uses the `Api-Key` header.
2. Models: `ideogram-4-5`, `ideogram-4`, `ideogram-3`, `ideogram-2a`.
3. The content type varies by model: 4.5 / 3.0 take `multipart/form-data`; 4.0 / 2.x take JSON. Ideogram 4.5 is sized with `size` (and takes `quality`); 4.0 uses `resolution`; 3.0 / 2.x use `aspectRatio` plus `renderingSpeed`. Ideogram 3.0 accepts a negative prompt; 4.x and 2a do not.
4. When a source image is present, the request is routed to the model's edit action: 4.5 → `precise-edit` (extra images become `reference_images`), 4.0 → `remix`, 3.0 → `remix` (extra images become `style_reference_images`). Ideogram 2a has no edit path and rejects a source image. Result URLs expire, so images are downloaded immediately.

### Fireworks AI

1. API URL defaults to `https://api.fireworks.ai/inference/v1`.
2. Fireworks deprecated image generation (announced 2026-06-10) and retired the FLUX serverless models, so only the SDXL-class models still resolve: `stable-diffusion-xl-1024-v1-0` and `playground-v2-1024px-aesthetic`. Prefer another provider for new setups.
3. Configure `aspectRatio`, `guidanceScale`, `numInferenceSteps`, and `seed`. Lumiverse requests JSON so `finishReason` and `seed` come back with the image; a content-filtered result surfaces as an error.

### Stability AI

1. API URL defaults to `https://api.stability.ai`.
2. Models: `core`, `ultra`, `sd3`.
3. These endpoints take `multipart/form-data`. Configure `aspectRatio`, `outputFormat`, `stylePreset`, `cfgScale` (sd3), `seed`, and `negativePrompt`.
4. `ultra` and `sd3` accept a source image (sent as an `image` part). On `sd3` the request also sets `mode: image-to-image` and a `strength`; `aspect_ratio` is omitted for image-to-image. `core` has no image-to-image mode, so a source image is rejected with a clear error.

### Black Forest Labs

1. API URL defaults to `https://api.bfl.ai/v1`; auth uses the `x-key` header.
2. Models include `flux-2-pro-preview`, `flux-2-pro`, `flux-2-flex`, `flux-2-max`, `flux-2-klein-9b`, `flux-2-klein-4b`, `flux-3-image`, `flux-3-image-klein`, `flux-kontext-pro`, `flux-kontext-max`, `flux-pro-1.1`, `flux-pro-1.1-ultra`, and `flux-dev`.
3. Parameters are gated per FLUX family so unsupported fields are never sent: `guidance` on FLUX.2 Flex and FLUX Dev; `steps` on FLUX.2 Flex, FLUX 3 Klein and FLUX Dev; `seed` everywhere except `flux-3-image`; `output_format` everywhere except `flux-3-image`; `resolution` (768sq / 1k / 1.5k / 2k / 4k / match_input) on FLUX 3; prompt upsampling as `disable_pup` on FLUX.2 Pro/Max and `prompt_upsampling` on Flex, Ultra, Kontext, Dev and 1.1 Pro.
4. A source image is sent as `images[]` (FLUX 3), `input_image` / `input_image_2..8` (FLUX.2, up to eight) or `input_image` / `input_image_2..4` (Kontext, up to four), or `image_prompt` (FLUX 1.x). Submission returns a polling URL that Lumiverse polls until the job is ready; result URLs expire in about ten minutes, so the image is downloaded immediately.

### fal.ai

1. API URL defaults to `https://queue.fal.run`; auth uses the `Key <key>` scheme.
2. Models include `fal-ai/flux/schnell`, `fal-ai/flux/dev`, `fal-ai/flux-pro/v1.1`, and `fal-ai/stable-diffusion-v35-large`. These presets are text-to-image endpoints. For source-image generation, enter an image-to-image endpoint such as `fal-ai/flux/dev/image-to-image`.
3. Configure an `imageSize` preset, `numInferenceSteps`, `guidanceScale`, and `seed`. Lumiverse submits to the queue, polls status, then fetches the result.

### Replicate

1. API URL defaults to `https://api.replicate.com/v1`.
2. Official models (for example `black-forest-labs/flux-schnell`) use the `/models/{owner}/{name}/predictions` path; community models use `owner/name:hash` and post to `/predictions` with a `version` field.
3. Configure `aspectRatio`, `numOutputs`, `outputFormat`, and `seed`. Lumiverse sends `Prefer: wait` and polls if the prediction is still running. Per-model inputs are reachable through the raw-request override.

### Leonardo.Ai

1. API URL defaults to `https://cloud.leonardo.ai/api/rest/v1`.
2. The model field takes a model UUID; a name is resolved via the models endpoint.
3. Configure width/height, `numImages`, `contrast`, `alchemy`, `ultra`, `enhancePrompt`, and `seed`. Generation is asynchronous: Lumiverse polls until the job completes.

### Runware

1. API URL defaults to `https://api.runware.ai/v1`.
2. Model ids may reference Civitai checkpoints directly (for example `civitai:112902@126688`).
3. Configure width/height, `numberResults`, `steps`, `CFGScale`, and `seed`. Lumiverse posts a task array and reads the image URL from the response `data[]`.
4. A source image is sent as `inputs.seedImage` (a data URL) with an optional `strength` for image-to-image. A model that has no image-to-image mode rejects the input, which surfaces as an error.

### Civitai

Two connections are available:

- **Civitai** uses the native workflow API (`/v2/consumer/workflows`). Choose an ecosystem (`anima`, `sdxl`, `sd1`, `flux1`) and engine, and configure `cfgScale`, `steps`, `seed`, `quantity`, a LoRA map (`{ "urn:air:...": strength }`), the queue `tier`, and `whatif` for a cost preview. Anima uses its built-in model; for SD ecosystems select the checkpoint AIR URN and matching ecosystem.
- **Civitai (Chat)** uses the chat-completions image path with `modalities: ["image", "text"]`. Configure an `aspectRatio`, `imageSize` (0.5K–4K), and `tier`. Models include hosted third-party image models and Civitai AIR URNs; there are no LoRAs or samplers on this path.

Both default to `https://orchestration.civitai.com`.

### Hugging Face

1. API URL defaults to `https://router.huggingface.co`.
2. The model field carries `{org}/{model}` (for example `black-forest-labs/FLUX.1-schnell`).
3. Configure `negativePrompt`, `numInferenceSteps`, `guidanceScale`, and `seed`. The token needs the **Make calls to Inference Providers** permission.

---

## ComfyUI Workflows

ComfyUI doesn't have fixed parameters — your workflow defines what's adjustable. Lumiverse handles this with a **workflow import** step.

### Importing

1. In **Configure Generation… → Generation**, choose **Import Workflow** (or **Edit Workflow** for an existing workflow) and upload a workflow JSON (either the editor's "graph" format or the "API" format).
2. Lumiverse parses the graph and auto-detects the nodes that should receive standard parameters (positive prompt, negative prompt, sampler, steps, CFG, seed, width, height, checkpoint).
3. Review the detected **field mappings** — every parameter is shown alongside the node and field it routes to. Adjust mappings if Lumiverse picked the wrong node.
4. Save. The workflow JSON and your mappings live on the connection.

### Custom Fields

If your workflow has parameters that aren't in the standard set (for example, a LoRA strength or a custom sampler choice), expose them as **custom fields**. They appear in **Generation Settings → Generation**, under the workflow and override the matching node value at generation time.

### Capabilities Discovery

The connection's **Capabilities** button queries the live ComfyUI server for available samplers, schedulers, and checkpoints. Use this whenever you add new models on the ComfyUI side so the panel pickers stay in sync.

---

## Connection Parameter Persistence

Provider controls in **Generation Settings** update the active connection’s **default parameters** immediately. Those settings are reused whenever that connection is selected, including other chats. Clearing an override allows the provider/schema default to apply where supported.

**Done** closes the modal; it does not save or cancel a staged transaction. To keep separate parameter configurations, duplicate the connection and switch between profiles from the drawer.

---

## Migration From Legacy Settings

If you ran a previous version of Lumiverse that stored Gemini / NanoGPT / NovelAI keys in the global settings blob, those entries are migrated to encrypted connection profiles the first time you open the Image Generation panel. You don't need to do anything — the old keys disappear from settings and new connections appear in the picker.

---

## Tips

!!! tip "Keep experiments in a separate connection"
    Duplicate a connection before trying a different set of parameters. Generation Settings writes changes to the active profile immediately.

!!! tip "Pre-warm slow connections"
    For ComfyUI / SwarmUI with large models, the first generation after a server restart can be slow while the checkpoint loads. Either bump the **Image Generation Timeout** (see [Scene, Output & Timeouts](scene-and-output.md)) or run a quick test from your server's UI first.

!!! warning "Local providers need network access"
    If Lumiverse is running in a container or VM, make sure the ComfyUI / SwarmUI URL is reachable from the Lumiverse process — not just from your browser.
