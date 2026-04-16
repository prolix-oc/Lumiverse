# Themes

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
| **Auto** | Follows your system preference |

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

You can save and share theme configurations:

- **Export** — Save your current theme settings as a shareable file
- **Import** — Load a theme configuration from a file

---

## CSS Variables

The theme system works through CSS custom properties (variables). All colors, spacing, and visual properties are defined as variables that cascade through the entire UI. This means:

- Theme changes are instant (no page reload)
- Extensions can override specific variables without breaking others
- All UI components automatically adapt to theme changes
