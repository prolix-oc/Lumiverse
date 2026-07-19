---
title: Theme
---

# Theme

Lumiverse's theme system lets you customize the entire visual appearance — colors, fonts, glass effects, and more.

---

## Theme Panel

Open the **Theme Panel** to access all visual settings:

### Mode

Choose your base theme:

| Mode | Description |
|------|-------------|
| **Dark** | Dark background with light text (default) |
| **Light** | Light background with dark text |
| **System** | Follows your operating system's light/dark preference |

### Accent Color

The primary accent color used for buttons, links, highlights, and focus states. Pick any color using the color picker or enter a specific HSL value.

### Base Colors

Customize the background and text colors for each mode independently. The dark and light modes each have their own base color set.

### Radius Scale

Controls the roundness of UI elements (buttons, cards, inputs):

- **Low** — Sharp corners, minimal rounding
- **Medium** — Balanced rounding (default)
- **High** — Very rounded, pill-shaped elements

### Font Scale

Adjusts the global text size. Useful for accessibility or personal preference.

### UI Scale

Scales every UI element — panels, controls, chrome — proportionally between 0.8× and 1.5×. Where **Font Scale** only resizes text, **UI Scale** zooms the entire interface, which is handy on very high-density displays or for people who like a more compact (or more spacious) layout overall.

### Glass Effect

Enables a frosted-glass look with backdrop blur on panels, modals, and headers. When disabled, elements use solid backgrounds instead.

!!! note "Performance"
    Glass effects use CSS `backdrop-filter: blur()`, which can be GPU-intensive. If you notice performance issues (especially on older devices), disable glass effects.

---

## Preset Themes

The Theme Panel includes a grid of pre-built themes you can apply with one click. These set a coordinated combination of mode, accent color, base colors, and other settings.

---

## Character-Aware Theming

When enabled, the theme automatically adapts its accent color to match the current character's avatar. Colors are extracted from the avatar image and applied as a subtle tint to the UI.

This creates a unique visual feel for each character — one character might tint the UI warm amber, another cool blue.

---

## Extension Themes

Extensions can apply CSS variable overrides on top of your theme. Active extension themes are shown in the Theme Panel with attribution (which extension is applying them).

Extension theme overrides are scoped per-extension and automatically cleared when the extension is disabled.

---

## Importing & Exporting Themes

You can save and share theme configurations from the **Theme Panel**:

- **Export** — Save the current theme settings (mode, accent, base colors, radius, scales, glass) as a JSON file
- **Import** — Load a theme JSON

For richer sharing — including custom CSS, component overrides, and bundled assets — use **Theme Packs** (see below).

---

## Custom CSS & Component Overrides

For full styling control beyond what the Theme Panel exposes, open **Settings → Appearance → Custom CSS** (or invoke the Custom CSS modal from the Theme Panel). It supports:

- **Custom CSS** — raw CSS that's injected after the built-in stylesheet, so you can override any variable or selector
- **Component Overrides** — safe TSX decorators for built-in components (advanced; imported overrides are quarantined until you explicitly approve them, for safety)

Component starter templates render `<Original />`, a trusted slot containing the
complete built-in component. Keep that slot in the template and add markup around
it so native behavior—actions, swipes, editing, greetings, accessibility, and new
features added in later releases—continues to work. Removing `<Original />` opts
into a full replacement, which means the replacement must recreate every feature
it needs.

```jsx
export default function BubbleMessage(props) {
  return (
    <>
      <Original />
      <div className="message-decoration">✦</div>
    </>
  )
}
```

Use per-component CSS when the change is purely visual; it layers onto the native
component without changing its React structure.

### Choosing message avatar resolution

The example below intentionally replaces the built-in message markup because it
changes the avatar source, not just its presentation. A full replacement must
also render any actions or controls it wants to retain. For sizing, cropping,
borders, and other visual avatar changes, keep `<Original />` and use CSS instead.

`BubbleMessage` and `MinimalMessage` component overrides receive the same avatar sources. Use `message.avatar` when the theme needs a specific shape or resolution:

```jsx
export default function BubbleMessage({ message, styles }) {
  const avatarSrc = message.avatar.cropped.lg || message.avatar.cropped.sm || message.avatarUrl

  return (
    <div className={styles.card || ''}>
      <img src={avatarSrc || ''} alt={message.displayName} />
      <Content />
    </div>
  )
}
```

The available sources are:

- `message.avatar.cropped.sm`, `.lg`, and `.full` — the square crop at about 300 px, about 700 px, or original resolution
- `message.avatar.original.sm`, `.lg`, and `.full` — the uploaded aspect ratio at those same tiers
- `message.avatarUrl` — the source selected by the current message style; it also follows that style's **Use full-size avatars** preference
- `message.fullAvatarUrl` — the original aspect ratio at full resolution

Use the same expressions in a `MinimalMessage` override; only the exported function/component being overridden changes. Changing an image's `src` requires a component override—Custom CSS can resize or crop the rendered image, but cannot select another source URL.

---

## Theme Assets & Bundles

When your custom CSS needs imagery (cursors, backgrounds, decorative SVGs, icon sets), upload it as a **theme asset** instead of pasting a remote URL:

1. Open the **Theme Assets** panel inside the Custom CSS modal
2. Drag an image, SVG, or font file onto the upload zone — Lumiverse assigns it a slug under a per-theme `bundle_id`
3. Reference it from your CSS with the relative path the panel gives you (e.g. `url(./my-cursor.png)`); Lumiverse rewrites those references to the safe `/api/v1/theme-assets/bundles/...` URL at runtime so paths keep working when the theme is shared

Optimizing uploaded PNG/JPG assets to WebP is available from each asset's menu — useful for trimming large theme packs.

---

## Theme Packs

A **Theme Pack** bundles everything together — theme variables, custom CSS, component overrides, and uploaded assets — into a single shareable file. From the Custom CSS modal you can:

- **Export Pack** — Package the current theme + CSS + assets into a zip you can hand to someone else
- **Import Pack** — Load a pack into Lumiverse. Imported component overrides arrive disabled by default and must be explicitly enabled, which prevents an untrusted pack from running arbitrary code on import.

Theme Packs travel with their assets, so a recipient sees exactly what you see without needing to re-upload images.

### Safe theme recovery

If custom CSS or a component override makes the interface inaccessible, open Lumiverse with `?safe-theme=1` appended to its URL, for example `https://lumiverse.example.com/?safe-theme=1`. This suppresses custom CSS and component CSS/TSX overrides for that browser session without deleting them. Remove the query parameter and reload when the theme has been repaired.

Server operators and theme developers can also start Lumiverse with safe theme mode enabled:

```bash
./start.sh --safe-theme
# Windows PowerShell: .\start.ps1 -SafeTheme
# Direct/server/container launches can set LUMIVERSE_SAFE_THEME=true instead.
```

The startup flag applies to every browser using that server. Unset it and restart Lumiverse to restore saved styling. The existing `Ctrl+Shift+U` shortcut remains available when the app has mounted; unlike safe theme mode, the shortcut persists the disabled state of the current CSS and component overrides.

---

## CSS Variables

The theme system works through CSS custom properties (variables). All colors, spacing, and visual properties are defined as variables that cascade through the entire UI. This means:

- Theme changes are instant (no page reload)
- Extensions can override specific variables without breaking others
- All UI components automatically adapt to theme changes
