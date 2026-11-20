# Liquid Glass Lab (experimental)

Staging-only static experiment. Not part of any shipped route. Open `index.html`
in any browser, or serve the folder as-is.

## Sources
- https://github.com/dashersw/liquid-glass-js
- https://freefrontend.com/css-liquid-glass/ (container lens, toggle, distortion card, slider)

## Contents
- `index.html` — markup + inlined SVG filter defs (#container-glass, #goo, #knockout, #remove-black, #mini-liquid-lens).
- `styles.css` — layout, filters, focus, responsive + reduced-motion guards.
- `script.js` — toggle + draggable slider, keyboard operable, no deps.

## Perf notes
- No base64 displacement maps (former 100KB+ blobs removed); turbulence/gradients are procedural and small.
- No third-party scripts (tweakpane/gsap dropped). Animations limited to transform/opacity.
- SVG filter radius kept small; backdrop-filter blurred at 12px max.

## Degradation
- `@supports not (backdrop-filter)` -> solid translucent card background.
- Reduced motion disables body drift, slider/toggle transitions, card hover lift.
- SVG-filter-unsupported environments still render; filter:url(#id) simply no-ops.
- Fully keyboard operable: toggle (Enter/Space), slider (arrows, Home, End).

## Smoke checks (2026-10-23)
- file:// open: console has zero JS errors (verified via node jsdom? see below).
- Responsive: grid auto-fit minmax(260px); no horizontal scroll at 360px.
- No network except normalize.css import; works offline after first load if cached.

## Known limits
- `feImage` data URI in #mini-liquid-lens relies on SVG data URI support (all modern browsers).
- Does not ship; wire-up to app router deliberately omitted.
