# Theme

!!! warning "Permission required: `app_manipulation`"

Apply CSS variable overrides on top of the user's current theme. Overrides are scoped to your extension and automatically removed when the extension is disabled or unloaded. Active extension themes appear in the user's Theme panel with attribution.

## `spindle.theme.apply(overrides)`

Push CSS variable overrides to the frontend. Subsequent calls merge with any previously applied overrides from your extension — new keys are added, existing keys are overwritten. The UI updates immediately via WebSocket.

```ts
await spindle.theme.apply({
  variables: {
    '--lumiverse-primary': 'hsl(210, 80%, 60%)',
    '--lumiverse-prose-dialogue': 'hsl(210, 70%, 75%)',
  },
})
```

### Mode-Aware Overrides

Use `variablesByMode` to specify different values for light and dark mode. When the user switches modes, the frontend automatically selects the matching set. Mode-specific values take precedence over flat `variables` for the same key.

```ts
await spindle.theme.apply({
  // Flat variables apply in both modes
  variables: {
    '--lumiverse-primary': 'hsl(210, 80%, 60%)',
    '--lumiverse-prose-dialogue': 'hsl(210, 70%, 75%)',
  },
  // Mode-specific variables override flat values when active
  variablesByMode: {
    dark: {
      '--lumiverse-bg': 'hsl(210, 12%, 11%)',
      '--lumiverse-bg-elevated': 'hsl(210, 12%, 14%)',
      '--lcs-glass-bg': 'hsla(210, 12%, 6%, 0.55)',
    },
    light: {
      '--lumiverse-bg': 'hsl(210, 20%, 96%)',
      '--lumiverse-bg-elevated': 'hsl(210, 20%, 100%)',
      '--lcs-glass-bg': 'hsla(210, 20%, 92%, 0.55)',
    },
  },
})
```

### ThemeOverrideDTO

| Field | Type | Description |
|---|---|---|
| `variables` | `Record<string, string>` | CSS custom property overrides applied regardless of mode. Keys must start with `--`. Max 200 per extension. |
| `variablesByMode` | `{ dark?: Record<string, string>; light?: Record<string, string> }` | Mode-specific CSS overrides. Selected based on the user's resolved mode. Override flat `variables` for the same key. |

### Available CSS Variables

Lumiverse generates 100+ CSS custom properties from the active theme. All are overridable:

| Group | Variables |
|---|---|
| **Primary accent** | `--lumiverse-primary`, `-hover`, `-light`, `-muted`, `-text`, `-010`, `-015`, `-020`, `-050`, `-contrast` |
| **Backgrounds** | `--lumiverse-bg`, `-elevated`, `-hover`, `-dark`, `-darker`, `-deep`, `-040`, `-050`, `-070`, `-elevated-040`, `-deep-080`, `-scene-text-scrim` |
| **Text** | `--lumiverse-text`, `-muted`, `-dim`, `-hint` |
| **Borders** | `--lumiverse-border`, `-hover`, `-light`, `-neutral`, `-neutral-hover` |
| **Status** | `--lumiverse-danger`, `--lumiverse-success`, `--lumiverse-warning` (each with `-015`, `-020`, `-050` variants) |
| **Glass** | `--lcs-glass-bg`, `-bg-hover`, `-border`, `-border-hover`, `-blur`, `-soft-blur`, `-strong-blur` |
| **Prose** | `--lumiverse-prose-italic`, `-bold`, `-dialogue`, `-blockquote`, `-link` |
| **Shadows** | `--lumiverse-shadow`, `-sm`, `-md`, `-lg`, `-xl` |
| **Radii** | `--lumiverse-radius`, `-sm`, `-md`, `-lg`, `-xl`, `--lcs-radius`, `-sm`, `-xs` |
| **Fills** | `--lumiverse-fill`, `-subtle`, `-hover`, `-medium`, `-strong`, `-heavy`, `-deepest` |
| **Cards** | `--lumiverse-card-bg`, `--lumiverse-card-image-bg` |
| **Icons** | `--lumiverse-icon`, `-muted`, `-dim` |
| **Modals** | `--lumiverse-modal-backdrop`, `--lumiverse-gradient-modal`, `--lumiverse-swatch-border` |
| **Typography** | `--lumiverse-font-family`, `--lumiverse-font-mono`, `--lumiverse-font-scale` |
| **Transitions** | `--lumiverse-transition`, `--lumiverse-transition-fast`, `--lcs-transition`, `--lcs-transition-fast` |

---

## `spindle.theme.clear()`

Remove all CSS variable overrides from your extension. The UI reverts to the user's base theme immediately.

```ts
await spindle.theme.clear()
```

---

## `spindle.theme.getCurrent(userId?)`

Get a read-only snapshot of the user's current theme configuration. Returns the base theme info without any extension overrides applied.

```ts
const theme = await spindle.theme.getCurrent()
spindle.log.info(`Mode: ${theme.mode}, Accent: hsl(${theme.accent.h}, ${theme.accent.s}%, ${theme.accent.l}%)`)

if (theme.mode === 'dark') {
  await spindle.theme.apply({
    variables: { '--lumiverse-bg': 'hsl(220, 15%, 8%)' },
  })
}
```

### ThemeInfoDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Theme preset ID (e.g. `"lumiverse-purple"`, `"character-aware"`, `"custom"`). |
| `name` | `string` | Display name of the theme. |
| `mode` | `"light" \| "dark"` | Resolved mode — always concrete, never `"system"`. |
| `accent` | `{ h, s, l }` | Primary accent color in HSL (hue 0–360, saturation 0–100, lightness 0–100). |
| `enableGlass` | `boolean` | Whether glassmorphic backdrop-filter effects are enabled. |
| `radiusScale` | `number` | Border radius multiplier (1.0 = default). |
| `fontScale` | `number` | Font size multiplier (1.0 = default). |
| `characterAware` | `boolean` | Whether the theme dynamically adapts to the active character's avatar. |

---

## `spindle.theme.extractColors(imageId, userId?)`

Extract a color palette from an image stored in Lumiverse's image system. The image is sampled across five regions (top, center, bottom, left, right) plus a full-image dominant and average. This is the same algorithm Lumiverse uses internally for Character Aware theming.

```ts
// Extract colors from a character's avatar
const character = await spindle.characters.get(characterId)
if (!character?.image_id) return

const palette = await spindle.theme.extractColors(character.image_id)
spindle.log.info(`Dominant: hsl(${palette.dominantHsl.h}, ${palette.dominantHsl.s}%, ${palette.dominantHsl.l}%)`)
spindle.log.info(`Light image: ${palette.isLight}`)
```

### ColorExtractionResult

| Field | Type | Description |
|---|---|---|
| `dominant` | `ColorRGB` | Overall dominant color of the full image. |
| `regions` | `{ top, center, bottom, left, right }` | Dominant color per sampled region (each `ColorRGB`). |
| `flatness` | `{ top, center, bottom, left, right, full }` | Per-region flatness score (0–1). High values indicate monotone/solid regions that should be deprioritized. |
| `average` | `ColorRGB` | Simple average color across all sampled pixels. |
| `isLight` | `boolean` | Whether the dominant color is perceived as light (luminance > 152). |
| `dominantHsl` | `ColorHSL` | HSL representation of the dominant color. |

### ColorRGB / ColorHSL

```ts
interface ColorRGB { r: number; g: number; b: number }  // 0–255
interface ColorHSL { h: number; s: number; l: number }   // h: 0–360, s/l: 0–100
```

### Flatness Scores

The `flatness` field helps you avoid sampling background regions. A score above `0.5` indicates a monotone region (solid color fill, white/black background). When choosing which region to derive your accent from, prefer regions with lower flatness — they represent the "interesting" parts of the image (the character, not the background).

---

## User Visibility

When your extension applies theme overrides, users see an **Extension Themes** section in their Theme panel. Each entry shows your extension name, a color swatch strip, the number of overrides applied, and a dismiss button. This gives users full transparency into what's modifying their theme and the ability to remove overrides at any time.

Overrides are automatically cleared when:

- Your extension calls `spindle.theme.clear()`
- The extension is disabled or unloaded
- The extension worker crashes
- The user clicks the dismiss button in the Theme panel

---

## Example: Character-Derived Theme with Mode Support

This example extracts colors from the active character's avatar and applies a mode-aware theme that adapts to both light and dark mode.

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

async function applyCharacterTheme(characterId: string) {
  const character = await spindle.characters.get(characterId)
  if (!character?.image_id) {
    await spindle.theme.clear()
    return
  }

  const palette = await spindle.theme.extractColors(character.image_id)
  const hue = palette.dominantHsl.h
  const sat = Math.max(35, Math.min(70, palette.dominantHsl.s))

  await spindle.theme.apply({
    variables: {
      '--lumiverse-primary': `hsl(${hue}, ${sat}%, 58%)`,
      '--lumiverse-primary-hover': `hsl(${hue}, ${sat + 5}%, 52%)`,
      '--lumiverse-prose-dialogue': `hsl(${hue}, ${Math.min(sat + 10, 80)}%, 72%)`,
    },
    variablesByMode: {
      dark: {
        '--lumiverse-bg': `hsl(${hue}, 12%, 10%)`,
        '--lumiverse-bg-elevated': `hsl(${hue}, 12%, 13%)`,
        '--lumiverse-bg-deep': `hsl(${hue}, 14%, 7%)`,
        '--lcs-glass-bg': `hsla(${hue}, 12%, 6%, 0.55)`,
      },
      light: {
        '--lumiverse-bg': `hsl(${hue}, 18%, 96%)`,
        '--lumiverse-bg-elevated': `hsl(${hue}, 18%, 100%)`,
        '--lumiverse-bg-deep': `hsl(${hue}, 20%, 93%)`,
        '--lcs-glass-bg': `hsla(${hue}, 18%, 92%, 0.55)`,
      },
    },
  })
}

// React to chat switches
spindle.on('SETTINGS_UPDATED', async (payload: any) => {
  if (payload.key === 'activeChatId' && payload.value) {
    const chat = await spindle.chats.get(payload.value)
    if (chat?.character_id) {
      await applyCharacterTheme(chat.character_id)
    }
  }
})
```

## Example: Time-Based Theme

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

async function applyTimeTheme() {
  const hour = new Date().getHours()
  const isNight = hour < 6 || hour >= 20
  const isDusk = hour >= 17 && hour < 20

  if (isNight) {
    await spindle.theme.apply({
      variables: {
        '--lumiverse-primary': 'hsl(230, 50%, 55%)',
      },
      variablesByMode: {
        dark: {
          '--lumiverse-bg': 'hsl(230, 15%, 8%)',
          '--lumiverse-bg-elevated': 'hsl(230, 15%, 11%)',
          '--lcs-glass-bg': 'hsla(230, 15%, 5%, 0.6)',
        },
        light: {
          '--lumiverse-bg': 'hsl(230, 20%, 94%)',
          '--lumiverse-bg-elevated': 'hsl(230, 20%, 98%)',
          '--lcs-glass-bg': 'hsla(230, 20%, 90%, 0.6)',
        },
      },
    })
  } else if (isDusk) {
    await spindle.theme.apply({
      variables: {
        '--lumiverse-primary': 'hsl(25, 70%, 55%)',
      },
      variablesByMode: {
        dark: {
          '--lumiverse-bg': 'hsl(25, 10%, 12%)',
          '--lumiverse-bg-elevated': 'hsl(25, 10%, 15%)',
        },
        light: {
          '--lumiverse-bg': 'hsl(25, 18%, 95%)',
          '--lumiverse-bg-elevated': 'hsl(25, 18%, 98%)',
        },
      },
    })
  } else {
    await spindle.theme.clear()
  }
}

// Apply on start, then every 15 minutes
applyTimeTheme()
setInterval(applyTimeTheme, 15 * 60 * 1000)
```
