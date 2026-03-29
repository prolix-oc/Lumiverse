# Image Generation Setup

Image generation uses its own connection profiles, separate from your LLM connections.

---

## Creating an Image Gen Connection

1. Open the **Image Generation** panel
2. Click **New Connection** (or go to the image gen connections section)
3. Fill in:
    - **Name** — A label (e.g., "NovelAI Images," "Gemini Vision")
    - **Provider** — Select your image provider
    - **Model** — Choose a model (use the Models button to browse available ones)
    - **API Key** — Your provider's API key (stored encrypted)
4. Optionally set **default parameters** (resolution, quality, etc.)
5. Save

---

## Provider-Specific Setup

### Google Gemini

1. Use your Google AI API key
2. Models are fetched from Google's API, filtered to image-capable ones
3. Generates images using Google's native image generation

### NanoGPT

1. Use your NanoGPT API key
2. Model list is fetched live from their API (with fallback to 16 static models)
3. Supports a wide range of image generation models

### NovelAI

1. Use your NovelAI API key
2. Offers 6 built-in model options (no API endpoint for model listing)
3. Automatically uses Danbooru-style tags instead of prose prompts
4. Supports **director reference images** — character and persona avatars can be used as style references

---

## Image Generation Settings

Configure overall behavior in the Image Generation panel:

| Setting | Description |
|---------|-------------|
| **Active Connection** | Which image gen connection to use |
| **Scene Change Threshold** | How much the scene must change before generating a new image |
| **Force Generation** | Generate even if the scene hasn't changed |
| **Background Opacity** | How transparent the generated image appears behind the chat |
| **Fade Transition** | Animation duration when switching images (in milliseconds) |

---

## Manual vs. Automatic Generation

- **Manual** — Click the generate button in the Image Generation panel to create an image on demand
- **Automatic** — When configured, images generate whenever the scene changes beyond the threshold

Use **Force Generation** to trigger a new image even when the system thinks the scene hasn't changed enough.

---

## Generated Images

Generated images are:

- Saved to the images table with full thumbnail support
- Available in the image gallery
- Accessible via a public URL for push notifications and embeds
- Displayed as chat backgrounds at the configured opacity

---

## Migration from Legacy Settings

If you previously configured image generation through the older settings-based system (with API keys stored in settings), Lumiverse automatically migrates your provider configs to the new encrypted connection profile system on first use. No manual migration needed.

---

## Tips

!!! tip "Use a low scene change threshold for dynamic scenes"
    If your story moves between locations frequently, a lower threshold generates images more often. For slower-paced conversations, a higher threshold avoids unnecessary regeneration.

!!! tip "NovelAI director references"
    NovelAI supports using character and persona avatars as reference images for style consistency. The system automatically resolves these before generation.

!!! tip "Check the scene data"
    The Image Generation panel shows the extracted scene data. If the AI is misreading the scene, you can adjust your writing to be more explicit about the setting.
