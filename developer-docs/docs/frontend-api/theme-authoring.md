# Theme Authoring

`ctx.theme` is the persistent/native theme-authoring counterpart to the backend `spindle.theme` presentation API. Use `spindle.theme` for extension-scoped live variable overrides; use `ctx.theme` for native assets, `.lumitheme` packs, catalog inspection, and navigation into Lumiverse's Theme Editor.

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
