# Theme

!!! warning "Permission required: `app_manipulation`"

Apply CSS variable overrides on top of the user's current theme. Overrides are scoped to your extension and automatically removed when the extension is disabled or unloaded. Active extension themes appear in the user's Theme panel with attribution.

## `spindle.theme.apply(overrides)`

Push CSS variable overrides to the frontend. Small partial updates merge with any previously applied overrides from your extension — new keys are added, existing keys are overwritten. Full theme-sized payloads are treated as replacements for their scope (`variables`, `variablesByMode.dark`, `variablesByMode.light`) so stale alpha/glass/fill tokens do not accumulate across repeated theme regeneration. The UI updates immediately via WebSocket.

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

---

## `spindle.theme.applyPalette(palette, userId?)`

Apply a safe palette-driven theme without letting the extension push raw CSS variables. Lumiverse preserves the user's current glass, radius, font, and UI-scale settings, generates both light and dark variable maps internally, and owns alpha-heavy presentation tokens like fills, glass backgrounds, shadows, and scrims.

This is the preferred API for live theming from avatars, album art, or other frequently changing color sources.

Pass `null` when no valid color data is available. Lumiverse treats that as a clear operation for your extension's active palette override and immediately falls back to the user's currently selected base theme.

```ts
await spindle.theme.applyPalette({
  accent: { h: 210, s: 60, l: 58 },
}, userId)
```

```ts
// No usable palette right now? Clear the extension-owned palette override.
await spindle.theme.applyPalette(null, userId)
```

### ThemePaletteConfigDTO

| Field | Type | Description |
|---|---|---|
| `accent` | `{ h, s, l }` | Primary accent color in HSL. Lumiverse derives the final full palette and mode-aware CSS vars from this. |

### Notes

- `applyPalette()` never mutates the user's saved theme selection. It only layers an extension-scoped override on top.
- `applyPalette(null, userId?)` is equivalent to clearing that extension-scoped palette override.
- After a clear, the UI reverts to the user's current base theme and preferences (accent, glass, radius, font scale, UI scale, resolved mode).

### Available CSS Variables

Lumiverse generates 100+ CSS custom properties from the active theme:

When a user enables **Device-specific controls**, their local radius, font scale, UI scale, and glass preferences take precedence over extension overrides, including `applyPalette()`. Palette colors are retained while glass opacity follows the device preference. `getCurrent()` continues to return the account's authored base theme; device preferences are stored locally and are not included in that snapshot.

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

## `spindle.theme.clear(userId?)`

Remove all CSS variable overrides from your extension. The UI reverts to the user's base theme immediately.

```ts
await spindle.theme.clear()
await spindle.theme.clear(userId)
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

## `spindle.theme.generateVariables(config)`

Generate the full set of Lumiverse CSS variables from a theme configuration. Returns a `Record<string, string>` containing every CSS variable the theme engine would produce — primary accent variants, backgrounds, borders, text, glass tokens, shadows, radii, prose tokens, and more (~80+ variables). The result can be passed directly to `apply()` for a complete, coherent theme override.

This is the same engine that powers Lumiverse's built-in Character Aware theme. Instead of manually crafting individual CSS variables and risking gaps (e.g. forgetting `--lcs-glass-bg` while overriding `--lumiverse-bg`), you provide an accent color and mode and receive the entire variable map.

```ts
// Generate a complete blue theme for dark mode
const vars = await spindle.theme.generateVariables({
  accent: { h: 210, s: 60, l: 58 },
  mode: 'dark',
})

// Apply every variable at once — no gaps, fully coherent
await spindle.theme.apply({ variables: vars })
```

### Combining with `extractColors`

The most powerful pattern is extracting colors from an image and feeding the result directly into `generateVariables`:

```ts
const palette = await spindle.theme.extractColors(character.image_id)
const vars = await spindle.theme.generateVariables({
  accent: palette.dominantHsl,
  mode: 'dark',
})
await spindle.theme.apply({ variables: vars })
```

This gives your extension the same full-palette theming that Character Aware provides, with zero manual variable mapping.

### ThemeVariablesConfigDTO

| Field | Type | Default | Description |
|---|---|---|---|
| `accent` | `{ h, s, l }` | *(required)* | Primary accent color in HSL. |
| `mode` | `"dark" \| "light"` | *(required)* | Target color mode. |
| `enableGlass` | `boolean` | `true` | Whether to generate glassmorphic backdrop-filter tokens. |
| `radiusScale` | `number` | `1` | Border radius multiplier. |
| `fontScale` | `number` | `1` | Font size multiplier. |
| `uiScale` | `number` | `1` | Full UI zoom multiplier. |
| `baseColors` | `object` | — | Optional base color overrides (see below). |
| `statusColors` | `object` | — | Override danger/success/warning colors. |

### `baseColors`

When provided, these hex/hsl color strings override the accent-derived defaults for specific variable groups. The engine automatically generates all related variants (hover, muted, opacity stops, etc.) from each base color.

| Key | Affects |
|---|---|
| `primary` | `--lumiverse-primary` and all `-hover`, `-light`, `-muted`, `-text`, `-010` through `-050`, `-contrast` variants |
| `secondary` | `--lumiverse-secondary`, `-hover`, `-border` |
| `background` | `--lumiverse-bg`, `-elevated`, `-hover`, `-deep` |
| `text` | `--lumiverse-text`, `-muted`, `-dim`, `-hint` |
| `danger` | `--lumiverse-danger` and all variants |
| `success` | `--lumiverse-success` and all variants |
| `warning` | `--lumiverse-warning` and all variants |
| `speech` | `--lumiverse-prose-dialogue` |
| `thoughts` | `--lumiverse-prose-italic` |

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

This example extracts colors from the active character's avatar and applies a complete theme using `generateVariables`. Compare this to the manual approach — no need to guess variable names or worry about missing glass/border/shadow tokens.

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

async function applyCharacterTheme(characterId: string) {
  const character = await spindle.characters.get(characterId)
  if (!character?.image_id) {
    await spindle.theme.clear()
    return
  }

  const palette = await spindle.theme.extractColors(character.image_id)
  const theme = await spindle.theme.getCurrent()

  // Generate a complete variable map for both modes
  const darkVars = await spindle.theme.generateVariables({
    accent: palette.dominantHsl,
    mode: 'dark',
    enableGlass: theme.enableGlass,
    radiusScale: theme.radiusScale,
  })
  const lightVars = await spindle.theme.generateVariables({
    accent: palette.dominantHsl,
    mode: 'light',
    enableGlass: theme.enableGlass,
    radiusScale: theme.radiusScale,
  })

  // Apply with mode-awareness — every variable is covered
  await spindle.theme.apply({
    variablesByMode: { dark: darkVars, light: lightVars },
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

### Manual approach (partial overrides)

If you only need to override a few specific variables rather than the full theme, you can still use `apply()` directly. This is lighter weight but requires you to cover all relevant variables yourself — see the [Available CSS Variables](#available-css-variables) table.

```ts
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
      '--lcs-glass-bg': `hsla(${hue}, 12%, 6%, 0.55)`,
    },
    light: {
      '--lumiverse-bg': `hsl(${hue}, 18%, 96%)`,
      '--lumiverse-bg-elevated': `hsl(${hue}, 18%, 100%)`,
      '--lcs-glass-bg': `hsla(${hue}, 18%, 92%, 0.55)`,
    },
  },
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

## Persistent theme authoring

`spindle.theme.authoring` edits the user's saved native theme through the backend. It continues without an open browser. Mutations require `app_manipulation`. Requests use the same user scoping as the other backend theme methods.

Feature-detect `spindle.theme.authoring?.version === 1`. Call `request({ operation, args }, userId?)`. The SDK exports `ThemeAuthoringRequest` and `ThemeAuthoringOperations` for typed requests and results.

```ts
const api = spindle.theme.authoring
const current = await api.request({ operation: 'state', args: {} }, userId)
const result = await api.request({
  operation: 'install',
  args: {
    draft: { name: 'Readable', globalCSS: 'body { line-height: 1.5; }' },
    options: { expectedRevision: current.revision, mode: 'merge' },
  },
}, userId)
```

### Operations

| Operation | Arguments | Result |
|---|---|---|
| `state` | `{}` | Saved configuration, default configuration, global CSS, component overrides, revision and backup IDs |
| `validate` | `draft` | Validation warnings, without writes |
| `install` | `draft`, optional `options` | Revision, backup ID, optional library entry ID and installed asset bundle ID |
| `backup` | Optional `name` | Backup ID and revision |
| `restore` | `backupId`, `expectedRevision` | Backup ID for the replaced state and resulting revision |
| `export_current` | `{}` | Current theme as `.lumitheme` bytes |
| `export_draft` | `draft` | Draft as `.lumitheme` bytes |
| `import` | `bytes: Uint8Array` | Editable draft, newly uploaded assets and warnings. Does not apply the theme. |
| `asset_create_bundle` | `{}` | A fresh bundle ID. Does not write data. |
| `asset_list` | Optional `bundleId`, otherwise the active saved bundle | Asset metadata and CSS paths |
| `asset_upload` | `bundleId`, `name`, `mimeType`, `bytes`; optional `slug`, `tags`, `metadata` | Asset metadata |
| `asset_update` | `id`, `patch` containing `slug`, `tags` or `metadata` | Updated metadata |
| `asset_delete` | `id` | Whether an asset was deleted |
| `asset_optimize` | `id` | Metadata after WebP optimization |
| `asset_download` | `id` | Asset bytes |

Asset operations are scoped to the requesting user. Uploads support the native image, SVG and font formats, with a 50 MiB per-asset limit. Archive decoding uses the native codec and its limits: 200 MiB input, 50 MiB per entry, 250 MiB total expanded bytes and 500 entries.

### Drafts and conflicts

A draft accepts `name`, optional `author` and `description`, `theme`, `globalCSS`, `globalEnabled`, `components`, and `assetBundleId`. `theme` is a complete native theme configuration or `null`. Component entries are full CSS stylesheets with an optional `enabled` flag. A `null` entry removes that component override. Component IDs identify native or registered extension components; syntax validation does not establish whether a component is mounted.

`options.mode` defaults to `merge`, preserving omitted styling, existing component TSX and assets. `replace` replaces CSS and component overrides. Omitting `assetBundleId` preserves assets during a merge; `null` clears them. Assets use the native relative CSS paths returned by upload.

Applying requires a fresh `expectedRevision`. The backend compares it again when committing and saves the backup and replacement settings atomically. Concurrent edits reject with `THEME_CONFLICT`. Inspect the saved state and reconcile before retrying. Restore also rejects if the selected backup changed during preparation.

Set `apply: false, saveToLibrary: true` to save without applying. `saveToLibrary: true` with an applied edit also saves the result in My Themes. Failed preparation removes the assets it created. Successful operations publish the ordinary settings-update event so connected clients synchronize.

The authoring boundary validates CSS syntax and removes external imports and remote resource URLs. Browser support and selector matches still require visual inspection. It accepts CSS overrides only. Imports omit TSX, and restore cannot enable changed or previously disabled TSX without native-editor review. Applying a backend backup from the native theme library follows the same TSX review rules, restores embedded assets into a fresh bundle, and rejects if the theme or backup changes while assets are uploading.

Saved theme state excludes device-local presentation controls and transient extension overlays. Those can change the rendered appearance without changing the saved-theme revision. The backend does not infer a browser's resolved system mode or claim to have visually verified a result.

## Build references

Feature-detect `spindle.theme.references?.version === 1` before calling `references.request({ operation, args })`. This read-only API is independent of persistent authoring and exposes public build data without a user scope. It requires generated frontend reference artifacts.

| Operation | Arguments | Result |
|---|---|---|
| `components` | Optional `query`, `offset`, `limit` | Component IDs, categories and known root selectors |
| `component` | `id` | Build-specific class selectors, parts, source keys, template and props |
| `variables` | Optional `query` | Variable names and defaults |
| `search` | `query`; optional `kind: 'source' \| 'doc'`, `offset`, `limit` | Matching bundled lines and build identity |
| `read` | `kind`, `path`; optional `startLine`, `lineCount` | Numbered lines from a bundled source or guide and build identity |

Paths are keys in the generated bundle. They do not grant filesystem access. Search and component pages contain at most 100 items; reads contain at most 300 lines. References are public frontend source and guides, never user data or backend source. They describe the packaged build, not mounted elements or extension-provided runtime components.

The frontend build generates a content-addressed JSON asset and reconciles CSS module selectors with emitted stylesheets. No source catalogue is imported into the application's JavaScript. The backend loads the reference asset on demand and verifies its hash. Packaging currently adds approximately 9 MiB of uncompressed public reference data. Rebuild the frontend when sources or guides change, and use `bun run check:theme-reference` to check the generated input artifacts.
