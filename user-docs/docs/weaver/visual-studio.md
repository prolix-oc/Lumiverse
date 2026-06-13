# Visual Studio

Once a card is finalized, its dashboard grows an image side: generate a **portrait**, then derive a full **expression set** from it. It runs through your existing **image-gen connections** — the same ones the [Image Generation](../image-generation/index.md) feature uses — so any provider you've already set up is available here, with no extra configuration.

The dashboard rail holds the panes: **Card** (the finished fields), **Portrait**, **Expressions** (characters only — a world's narrator card runs a place, not a face), and for worlds the **World** hub and **People** panes. Scene and alternate-portrait panes are on the roadmap and marked as such in the rail.

---

## Portrait

Portraits are generated at a tall 2:3 aspect ratio (832 × 1216) suited to character art. You generate as many candidates as you like, then promote the one you want to the character's avatar.

1. Pick an **image-gen connection** — the provider on that connection decides what controls you get.
2. Write a **prompt** (and optional negative prompt), or use **Suggest tags** to draft one from the character.
3. Adjust **size**, **seed**, **variations**, and any provider-specific controls under **Advanced**.
4. **Generate.** Progress streams in, and finished images appear as candidates.
5. Pick a candidate and **Set as avatar**.

!!! tip "Suggest tags"
    **Suggest tags** reads the finalized character and drafts a starting prompt from it — a fast way to get a likeness that matches the card instead of typing tags from scratch. Treat it as a first draft and edit freely.

Setting the avatar takes effect immediately — no re-upload, no extra step — and you can keep generating and swap it as often as you like. The committed portrait also becomes the **source** for expressions, so commit the face you want the whole set to share before moving on.

For connecting and configuring a provider in the first place, see [Image Generation → Setup & Providers](../image-generation/setup.md).

---

## Expressions

The Expressions pane builds the character's emotion set — the images chat swaps between as the character's mood changes (see [Characters → Expressions](../characters/expressions.md) for how they display in chat).

The key idea: every expression is **derived from the committed portrait**, not generated fresh from text. The portrait's pixels carry the identity and the style, and the provider changes _only the face_ — so sad, angry, and shy are recognizably the same person in the same artwork, instead of eight loose rerolls.

**The grid:** one cell per expression — the eight standards (neutral, happy, sad, angry, surprised, afraid, disgust, shy) plus any labels you add (_"smug"_, _"flustered"_ — type it and **Add**; the Weaver knows how to stage a custom label). Each cell generates on its own, or **Generate missing** works through every empty cell one at a time, with **Stop** always available (finished cells stay).

**Per cell:** regenerate until it reads right, then **Use this expression** to commit it. Committed cells get an _In use_ badge, and chat picks the set up automatically — committing also enables expressions for the character.

!!! tip "What a good cell looks like"
    The same person, pose, framing, clothing, and background as the portrait, with only the face changed. The Weaver's per-emotion staging also guards against the genre's stock extras — tears stay off "sad" and motion lines stay off "afraid" unless you ask for them.

### Which connections can do this

Deriving from an image requires a provider that can take an image as **input**. The pane shows how your selected connection does it, and gates plainly if it can't:

| Mechanism | Providers | How it works |
|-----------|-----------|--------------|
| **Edit** | Google Gemini, NanoGPT | The portrait is edited directly with a facial-change instruction. No tag prompt needed — the pixels carry the character. |
| **Reference** | NovelAI | Generates with the portrait as a character-and-style reference, plus expression tags. |
| **img2img** | SD WebUI API, SwarmUI, ComfyUI | Runs the portrait through img2img with expression tags. The strength control is under **Advanced** — lower keeps more of the portrait. |

For **ComfyUI**, the connection's imported workflow must have an `init_image` mapping for img2img to be possible; a plain txt2img workflow is gated with that exact reason. A connection whose provider can't take an image at all is gated too — re-rolling expressions from pure text would lose the face, so it's never offered. The connection selector stays usable so you can switch to one that qualifies.

---

## Providers

What you can control depends on which provider the connection uses.

| Provider | Runs | What you control | Expressions |
|----------|------|------------------|-------------|
| **ComfyUI** | Local | Prompt, negative, size, seed — plus any node fields you mapped | img2img (needs an `init_image` mapping) |
| **SwarmUI** | Local | Prompt, negative, size, seed | img2img |
| **SD WebUI API** | Local | Prompt, negative, size, seed | img2img |
| **NovelAI** | Cloud | Prompt, resolution, seed | Character reference |
| **NanoGPT** | Cloud | Prompt, size, seed | Edit |
| **Google Gemini** | Cloud | Prompt, aspect ratio | Edit |

!!! warning "Pollinations isn't available here"
    Pollinations works for general [image generation](../image-generation/index.md) but is **not** supported in the Visual Studio. If your only image-gen connection is Pollinations, set up one of the providers above first.

### ComfyUI

ComfyUI gives you the most control, but it needs a one-time setup on the connection first: **import your workflow and map its fields** (at minimum, map a node field as the _positive prompt_). See [Image Generation → Setup & Providers](../image-generation/setup.md) for importing and mapping.

Once a workflow is mapped, the Visual Studio fills your prompt, negative prompt, size, and seed into the nodes you mapped — and any **extra fields you mapped** (steps, CFG, sampler, scheduler, checkpoint, or custom node inputs) appear as controls you can tune per generation. In the Expressions pane, Advanced shows only the denoise strength — the rest of the workflow's parameters belong to the workflow's own mapped fields, configured on the connection.

!!! warning "Map a workflow before generating"
    Without an imported workflow that has at least a positive-prompt mapping, ComfyUI generation can't run. The studio will tell you to import one first.

### SwarmUI

SwarmUI works two ways:

- **Plain** — pick a model on the connection and generate from a prompt with size and seed. No workflow needed.
- **With a workflow** — if you've imported and mapped a ComfyUI workflow on the SwarmUI connection, it behaves like ComfyUI above, with your mapped fields as controls.

### SD WebUI API, NovelAI, NanoGPT, Google Gemini

These are prompt-driven: write a prompt (and negative prompt where supported), set size or aspect ratio and seed, and generate. NovelAI leans on Danbooru-style tags; Gemini takes prose and uses the portrait aspect ratio; NanoGPT routes to whichever model you selected on the connection. Each provider's tunable parameters (from your connection's defaults) are available in the controls.
