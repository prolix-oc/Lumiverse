# Theme Authoring

`ctx.theme` provides browser-side native assets, `.lumitheme` packs, catalog inspection, and navigation into Lumiverse's Theme Editor. Backend extensions can use `spindle.theme.authoring` for saved-theme edits and archives without a browser. The existing `spindle.theme.apply` API provides transient extension-scoped presentation overrides.

Each subtree is independently versioned. Feature-detect the host capability before using it:

| API | Host capability | Permission |
|---|---|---|
| `ctx.theme.assets` | `theme-assets-v1` | Reads are free; upload, update, optimize, and delete require `app_manipulation` |
| `ctx.theme.packs` | `theme-packs-v1` | Export is free; import and install require `app_manipulation` |
| `ctx.theme.catalog` | `theme-catalog-v1` | Free, read-only |
| `ctx.theme.openEditor` | `theme-editor-navigation-v1` | Free |

```ts
const capabilities = ctx.host.capabilities
if ((capabilities['theme-assets-v1'] ?? 0) >= 1) {
  const assets = await ctx.theme.assets.list(bundleId)
  for (const asset of assets) {
    preview.src = asset.contentUrl       // authenticated live preview
    css += `url("${asset.cssPath}")`    // canonical ./assets/<slug> pack path
  }
}
```

The asset DTO deliberately provides both paths. Do not reconstruct either value from an asset id or slug.

## Safe theme-pack drafts

Extensions author a stable draft rather than Lumiverse's internal archive manifest:

```ts
const draft = {
  name: 'My Theme',
  globalCSS: ':root { --my-accent: #a855f7; }',
  components: {
    BubbleMessage: { css: '[data-component="BubbleMessage"] { border-radius: 12px; }' },
  },
  assetBundleId: bundleId,
}

const archiveBytes = await ctx.theme.packs.exportDraft(draft)
const result = await ctx.theme.packs.installDraft(draft, {
  apply: true,
  saveToLibrary: true,
})
```

Drafts cannot supply TSX. Native owns the canonical `.lumitheme` codec, asset localization, CSS sanitization, application revisions, and saved-theme workflow. `importArchive()` creates a fresh asset bundle and returns a safe draft without applying it; executable TSX from imported archives is omitted and reported in `warnings`.

## Catalog and editor navigation

`listComponents()` returns stable labels, categories, public selectors, and CSS/TSX availability without source paths. `listVariables()` returns the native reference defaults plus current computed values when available.

```ts
if ((ctx.host.capabilities['theme-editor-navigation-v1'] ?? 0) >= 1) {
  ctx.theme.openEditor({ target: 'component', componentId: 'BubbleMessage' })
}
```

The bridge intentionally does not expose settings mutation, Zustand stores, arbitrary TSX installation, or component source files.

## Wallpaper Library selectors

The portalled Wallpaper Library container has `data-component="WallpaperLibraryModal"`; its backdrop has `data-modal="WallpaperLibraryModal"`. Both retain CSS-module classes. Scope inner selectors to the container instead of targeting generic elements under `body`:

```css
[data-component="WallpaperLibraryModal"] [data-part="card"] {
  border-radius: 12px;
}
[data-component="WallpaperLibraryModal"] [data-part="card"][data-current="true"] {
  border-color: var(--lumiverse-primary);
}
```

Every named part also has a CSS-module class, available in the component CSS reference.

| Surface | `data-part` values |
|---|---|
| Header | `close`, `header`, `header-copy`, `title`, `subtitle`, `count` |
| Content and states | `content`, `error`, `state`, `grid` |
| Wallpaper card | `card`, `preview`, `preview-image`, `preview-placeholder`, `placeholder-label`, `video-badge`, `current-badge` |
| Metadata | `metadata`, `filename`, `metadata-row`, `metadata-label`, `metadata-value` |
| Actions | `card-actions`, `apply`, `delete`, `footer`, `load-more` |

Cards expose `data-current="true|false"` and `data-media-type="image|video"`. Metadata rows expose `data-field="uploaded|size|resolution"`; state messages expose `data-state="loading|empty"`. Conditional parts appear only when their content is present. These selectors apply to both global and chat wallpaper selection.
## Rendered element inspection

Feature-detect `ctx.host.capabilities` for `theme-inspection-v1` before using `ctx.theme.inspect`. This synchronous frontend method requires `app_manipulation` and an active extension context.

```ts
const result = ctx.theme.inspect({
  selector: '[data-component="BubbleMessage"]',
  properties: ['color', 'font-size', 'padding'],
  limit: 5,
})
```

The result contains the total match count and bounded matches with a tag, visibility flag, rectangle and computed styles. It does not return text or DOM handles. Selectors support classes, IDs, tags, simple combinators, exact `data-component` and `data-part` attributes, and basic positional pseudo-classes. Arbitrary attribute probes are rejected. Only presentation properties are accepted, excluding resource URLs, generated content and custom properties. Limits are 30 elements and 40 properties.

Inspection observes the current browser, including device-local controls and transient overlays. Saved-theme edits and archive operations are available through backend `spindle.theme.authoring` without a browser.
