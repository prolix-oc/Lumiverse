# Visuals & Finalizing

The **Visuals** tab generates a portrait for the Dream Weaver session. **Finalize** turns the session into a real character or scenario card.

Portraits are the only supported visual asset in the current version. Expressions and gallery images are planned for a later release.

---

## Visuals Tab

Dream Weaver shares its image-gen connections with [core image generation](../image-generation/index.md) — there is no separate setup. Whatever ComfyUI, SwarmUI, Gemini, NovelAI, NanoGPT, or Pollinations connections you've already configured will appear in the Visuals tab's connection picker.

The Visuals tab has two main regions:

| Region | What It Does |
|--------|--------------|
| **Portrait stage** | A two-pane view: **Accepted** (the current accepted portrait, or an empty state) and **New Result** (the latest candidate or generation progress). |
| **Source Settings Ribbon** | Image-gen connection, prompt fields, size / aspect ratio, seed, and provider parameters. |

If only one image-gen connection exists, the Visuals tab auto-selects it. Otherwise pick one from the dropdown.

---

## Prompts & Suggest Tags

The Visuals tab has its own positive and negative prompt fields — these are stored on the session's visual asset, not on the main image-gen prompt preset.

**Suggest Tags** sits next to the positive prompt. Clicking it runs a quick LLM pass that converts the accepted appearance and personality cards into image-generation tags, then offers them as autocomplete suggestions you can append to the prompt. Review the suggestion before applying — you can prune anything that doesn't fit before clicking _Apply_.

Tag suggestion is most useful when the accepted `/appearance` card is rich. If the suggested tags feel vague, run `/appearance` again with stronger direction first.

---

## Provider Settings

Each provider exposes the same parameters in the Visuals tab as it does in the main image-gen panel — see [Setup & Providers](../image-generation/setup.md#provider-specific-setup) for the full per-provider parameter lists. Standard controls appear in the ribbon:

- **Positive Prompt** — main image prompt.
- **Negative Prompt** — content to avoid.
- **Width / Height** — output resolution.
- **Aspect Ratio** — locked for some providers (NovelAI, Gemini) and free-form for others.
- **Seed** — explicit seed or a randomize button.

Provider-specific extras (steps, CFG, sampler, scheduler, etc.) are pulled from the connection's parameter schema and rendered inline. They're stored on the visual asset, so the seed you used for an accepted portrait survives a session reopen.

---

## ComfyUI Workflows

For ComfyUI connections, Dream Weaver needs an imported workflow before it can generate. The flow is the same as in core image gen:

1. Select a ComfyUI image-gen connection.
2. Open the **Workflow Editor** modal from the Visuals tab.
3. Paste a workflow JSON (graph or API format) and let Lumiverse auto-detect injection points (positive prompt, negative prompt, seed, width, height, steps, CFG, sampler, scheduler, checkpoint).
4. Adjust any field mappings that point at the wrong node.
5. Save. Dream Weaver stores the workflow + mappings on the **image-gen connection's metadata**, so the same workflow is available to the core Image Generation panel too.

Custom fields you've mapped on the connection (LoRA strengths, alternate samplers, etc.) appear in the Visuals tab as extra parameter controls.

See [ComfyUI Workflows](../image-generation/setup.md#comfyui-workflows) for the deeper walk-through.

---

## Generating a Portrait

1. Make sure the positive prompt has at least an appearance description. Use **Suggest Tags** if you want Dream Weaver to fill it in from the accepted cards.
2. Tune size, aspect, and provider parameters as needed.
3. Click **Generate Portrait**. Progress streams in the **New Result** pane (with step counts and live previews on ComfyUI / SwarmUI).
4. When the candidate appears, decide what to do with it:

| Action | Result |
|--------|--------|
| **Accept Portrait** | Saves the candidate as the accepted portrait. If one is already accepted, the button reads **Replace Portrait**. |
| **Regenerate** | Runs the image job again with the same settings. |
| **Discard** | Removes the candidate without changing the accepted portrait. |

The accepted portrait persists with the session. Reopening the session later keeps the selected portrait, and finalizing applies it to the linked card.

---

## Asset Guidance

Visual generation works best after the text fields take shape. Since portraits are the current supported asset type, the accepted `/appearance` card matters most.

Good portrait guidance includes:

1. Body type, age impression, hair, eyes, clothing, distinguishing marks.
2. Style constraints — illustration, anime, cinematic, realistic.
3. Composition and framing — bust portrait, full body, close-up, environmental portrait.
4. Things to avoid in the negative prompt.

If the portrait keeps drifting away from the card's vibe, sharpen `/appearance` first. The image prompt and the text card share the same source, so tightening one improves the other on the next pass.

---

## Finalizing

Click **Finalize Character** or **Finalize Scenario** in the Studio footer once the required fields are filled.

Dream Weaver requires these fields before finalizing:

| Required Field | Character Mode | Scenario Mode |
|----------------|----------------|---------------|
| Name / Title | Character name | Scenario title |
| Personality | Character behavior | Narrator or world behavior |
| First Message | Character opening message | Opening narration or scene prompt |

If any required field is empty, the footer reads _"Needs … before finalizing"_ and the button is disabled. Everything else — appearance, scenario, voice guidance, lorebook entries, NPCs, alternate greetings, portrait — is optional. Finalize will happily ship a minimal card.

### What Finalize Creates

| Output | What Happens |
|--------|--------------|
| **Generated card** | Name/title, description, personality, scenario, first message, and Dream Weaver metadata are saved. |
| **Launch chat** | Created the first time you finalize the session. |
| **World books** | Accepted lorebook entries and NPCs become world book entries attached to the card. |
| **Portrait** | The accepted portrait is applied as the card's avatar. |
| **Voice guidance** | The compiled voice string is attached to the card. |

Finalizing flips the session's status pill from **Draft** to **Linked**. The Character / Scenario switcher in the header is disabled at this point — the card type is locked in.

---

## Updating a Finalized Session

Once a session is linked, the Studio footer's button changes to **Update Character** or **Update Scenario**.

Update:

1. Reuses the same generated card and its character ID.
2. Keeps the existing launch chat.
3. Replaces world books Dream Weaver previously generated for this session, but **preserves world books you attached by hand** outside of Dream Weaver.
4. Applies the current accepted portrait when one is selected.
5. Re-writes name, description, personality, scenario, and first message from the accepted cards.

Use this when you've accepted revised cards after testing the result, or when you generated a better portrait from the same session.

---

## After Finalizing

Open the linked card in the **Character Browser** to review the saved fields. That's the best place for small manual edits, additional tags, alternate greetings, avatar tweaks, or exporting the card.

If the launch chat doesn't quite work, return to Dream Weaver, accept revised cards (or run more tools), and click **Update Character** / **Update Scenario** — the linked card refreshes in place.

---

## Tips

!!! tip "Iterate appearance before generating"
    A vague `/appearance` card gives the image model nothing concrete to anchor on. Spend a Run again or Adjust on `/appearance` before clicking Generate Portrait and you'll waste fewer image credits.

!!! tip "Reuse a ComfyUI workflow across both panels"
    Workflows are stored on the connection, not on the Dream Weaver session. Import once and both the Dream Weaver Visuals tab and the core Image Generation panel will see it.

!!! warning "Update doesn't touch manually-edited fields outside Dream Weaver"
    If you edited the linked card in the Character Browser after finalizing, those edits get overwritten when you next click **Update**. Either re-do them in the Studio first or be ready to redo them in the Browser after the update.
