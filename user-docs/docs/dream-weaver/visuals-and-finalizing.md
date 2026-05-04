# Visuals & Finalizing

The **Visuals** tab generates image assets for the current Dream Weaver session. Portraits are the only supported asset type in the current version. Expressions and gallery images are planned for later.

When you finalize a session, Dream Weaver saves the result as a character or scenario card. The first time you finalize a session, it also creates the launch chat.

---

## Visuals Tab

Dream Weaver uses the cards you have accepted to prepare image prompts. The visual workflow depends on your image generation setup. In the current version, the generated asset is a portrait.

| Area | What It Does |
|------|--------------|
| **Portrait stage** | Shows the accepted portrait, candidate image, or generation progress |
| **Source settings** | Chooses the image provider, preset, workflow, size, seed, and provider options |
| **Prompt fields** | Stores the positive and negative prompt for the selected visual asset |
| **Suggest Tags** | Uses the Dream Weaver text connection to turn accepted card details into image tags |
| **Generate Portrait** | Starts an image job from the current visual asset settings |

For provider setup, see [Image Generation](../image-generation/index.md).

---

## ComfyUI Workflows

For ComfyUI connections, Dream Weaver needs an imported workflow before it can generate.

1. Select a ComfyUI image connection
2. Import a workflow JSON
3. Review detected prompt, negative prompt, seed, width, and height mappings
4. Map any missing required fields
5. Generate once the Visuals tab is ready

Dream Weaver stores the workflow on the image connection metadata, not on a single Dream Weaver session.

---

## Asset Guidance

Visual generation works best after you have accepted name/title, appearance, and personality cards. Since portraits are the current supported asset type, improve the accepted `/appearance` card first when the image prompt feels vague.

Good portrait guidance includes:

1. Body type, age impression, hair, eyes, clothing, and distinguishing marks
2. Style constraints, such as illustration, anime, cinematic, or realistic
3. Composition and framing, such as bust portrait, full body, close-up, or environmental portrait
4. Things to avoid in the negative prompt

Use **Suggest Tags** when you want Dream Weaver to turn accepted card details into image tags. Review the suggestion before applying it.

---

## Accepting a Portrait

When an image job completes, the result appears as a candidate image.

| Action | Result |
|--------|--------|
| **Accept Portrait** | Saves the candidate as the accepted portrait |
| **Replace Portrait** | Replaces the previously accepted portrait |
| **Regenerate** | Runs the image job again |
| **Dismiss** | Removes the candidate without changing the accepted portrait |

Accepted visual assets are saved with the Dream Weaver session. Reopening the session keeps the selected portrait.

---

## Finalizing

Use **Finalize Character** or **Finalize Scenario** when the result is ready.

Dream Weaver requires these fields before finalizing:

| Required Field | Character Mode | Scenario Mode |
|----------------|----------------|---------------|
| Name/title | Character name | Scenario title |
| Personality | Character behavior | Narrator or world behavior |
| First message | Character opening message | Opening narration or scene prompt |

If any required field is missing, Dream Weaver warns you before it calls finalize.

Finalizing creates or updates:

| Output | What Happens |
|--------|--------------|
| **Generated card** | Name/title, description, personality, scenario, first message, and Dream Weaver metadata are saved |
| **Launch chat** | Created the first time you finalize the session |
| **World books** | Accepted lore and NPC cards become attached world book entries |
| **Portrait** | The accepted portrait is applied as the card image when available |

---

## Updating a Finalized Session

After a session has been finalized, the footer action changes to **Update Character** or **Update Scenario**. Updating keeps the same linked card.

Updating:

1. Reuses the same generated card
2. Keeps the existing launch chat
3. Replaces Dream Weaver-generated world books from that session
4. Preserves manually attached world books
5. Applies the current accepted portrait when one is selected

Use this when you accept revised cards after testing the result, or when you generate a better portrait from the same Dream Weaver session.

---

## After Finalizing

Open the generated card in the **Character Browser** to review saved fields. This is the best place to make small manual edits, add tags, change avatars, or export the card.

If the launch chat does not feel right, return to Dream Weaver, accept revised cards, and update the same session.
