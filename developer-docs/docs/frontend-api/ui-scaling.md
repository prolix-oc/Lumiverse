# Global UI scaling

The application uses one scale boundary on `body`. React's root, body portals,
and extension portal containers all inherit the same effective scale. Keep
component transforms for animation and dragging; do not apply the global scale
to individual portals or add it again to `#root`.

`theme/reset.css` gives body explicit viewport dimensions divided by the UI
scale. `#root` fills that body with `100%` dimensions. The previous combination
of zoom on each body child and `width: calc(100% / scale)` on `#root` compensated
twice: in Chromium, 150% produced an 800px root in a 1200px viewport.

Native CSS zoom is the default. The existing Linux Tauri workaround uses the
individual `scale` transform on the same sized body. This makes body the common
containing block for fixed descendants. Applying that transform to each portal
instead gave nested wrappers their own origins and displaced right/bottom
anchored controls. Browsers without CSS zoom use this body fallback as well.

The fixed app shell uses `overflow: clip`, with scrolling owned by its views.
`overflow: hidden` still permits focus-driven scrolling; Firefox could pan the
whole shell horizontally when a scaled control exceeded the available width.

## Coordinates and viewport sizes

- Pointer `clientX/Y` and `getBoundingClientRect()` use rendered pixels. Divide
  once with the helpers in `lib/uiScale.ts` when assigning layout-space offsets.
- `offsetWidth/Height`, `clientWidth/Height`, `scrollTop/Left`, and ResizeObserver
  content sizes use layout pixels. Do not divide them again. The sortable helper
  keeps pointer deltas separate from scrolling for this reason.
- Import `DndContext` alongside `useScaledSortableStyle` from `lib/dndUiScale.ts`.
  The shared context also normalizes dnd-kit's inverse-transform measurement.
  Without it, remeasuring an active row in WebKit feeds a false layout shift
  back into the drag, even when pointer movement is divided correctly. A cached
  feature probe accounts for Firefox's different matrix serialization without
  browser detection; other dnd-kit props and custom measuring options pass through.
- Viewport units are not automatically compensated by CSS zoom, even on `html`.
  Use `--app-scaled-viewport-width/height` for overlays that must fit the visible
  viewport. Shared dialogs additionally cap their height to the backdrop, and
  dropdowns cap their measured width to the viewport.
- `--app-shell-height` is an unscaled, keyboard-stable CSS length. Only body
  divides it. `main.tsx` tracks the visual viewport and keyboard inset but does
  not calculate a second shell height. Keep browser pinch zoom separate from
  the saved UI scale.
- Theme application runs in a React layout effect before paint. Saved settings
  are validated against the 50–150% slider range.

CSS zoom does not change media-query breakpoints like browser page zoom does.
Use available container space for new responsive layouts and keep native browser
zoom available. A root-font-size replacement alone would not scale the existing
pixel-based controls, icons, and persisted panel dimensions.

## Verification

Run `node scripts/e2e-diagnostics/check-ui-scale.mjs` after installing the frontend
and diagnostics dependencies and Playwright's Chromium, Firefox, and WebKit
browsers. `UI_SCALE_BROWSERS=chromium` selects one engine.

The suite bundles the real styles and React 19 components in StrictMode. It
checks live scale changes, regular/fixed root content, direct/nested portals,
centered/fixed controls, dropdowns, animated context menus, tall modals, and
sortable pointer movement with scrolling. It also checks viewport resizing and
a simulated keyboard viewport reduction. Desktop and PWA flags exercise their
CSS paths; these are not native Tauri or physical-device keyboard tests.

## Research

Primary sources found using Exa:

- [MDN: CSS zoom](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/zoom)
  describes layout-aware scaling and browser support.
- [CSS Viewport Module, DOM/CSSOM interaction](https://drafts.csswg.org/css-viewport/#zoom-cssom)
  defines scaled rectangles versus unscaled layout measurements (editor's draft).
- [CSSWG discussion: zoom on the root element](https://github.com/w3c/csswg-drafts/issues/13016)
  documents why moving zoom to `html` does not solve viewport-unit sizing.
- [MDN: transform](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/transform)
  explains the containing block created for fixed descendants.
- [React: createPortal](https://react.dev/reference/react-dom/createPortal) and
  [useLayoutEffect](https://react.dev/reference/react/useLayoutEffect) explain
  physical DOM placement and measurement before paint.
- [dnd-kit rectangle measurement](https://github.com/clauderic/dnd-kit/blob/master/packages/core/src/utilities/rect/getRect.ts)
  shows where inverse transforms enter its geometry pipeline.
