# Lumiverse Quick Toolbar Diagnostics

Current extension version: `1.1.1`.

This is a local Chrome Manifest V3 extension for persistent Quick Toolbar
diagnostics. It is read-only except for the explicit runtime reset button.

## Load it

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this directory:

   `G:\AI\All lumiverse repos\Lumiverse\tools\quick-toolbar-diagnostics-extension`

5. Open the Lumiverse chat at `http://localhost:7860`.
6. Open the extension popup and use **Capture** or **Capture + mark**. Labels
   are derived automatically from the live DOM/settings state; the label field
   is only for an optional custom name.

The popup checks for the content script and injects it into an already-open
matching chat when needed. You do not have to close and reopen the tab after
reloading the unpacked extension.

The content script captures page loads, route changes, visibility changes, and
debounced Quick Toolbar/chat-top-dock setting and lifecycle mutations
automatically. Reports are stored in `chrome.storage.local` by the extension
service worker and survive page reloads. Derived labels include
`dock-fill-off`, `dock-fill-on`, `dock-fill-on-to-off`, floating auto-fit/fill
states, and toolbar disable/re-enable transitions.

The extension uses `storage` and `scripting` with the localhost host permission.
The `scripting` permission only installs the diagnostics content script into an
already-open matching chat after an unpacked-extension reload; `activeTab` is
not requested.

## Runtime reset

**Reset SW/cache + reload** unregisters service workers and deletes Cache
Storage for the current page origin, then reloads the page. It preserves
cookies, IndexedDB, localStorage, and login state. This is intentionally
limited to the current `localhost:7860` origin.

**Copy history JSON** and **Save history JSON** always export the complete
persisted history, including reports captured before a page reload or from a
different localhost tab. Save writes a timestamped JSON file through the
browser download flow.

## Probe without the extension

Paste [`probe.js`](./probe.js) into DevTools. It installs
`window.LumiverseQuickToolbarProbe`, captures a `manual-paste` report, and
copies the JSON report to the clipboard.

Useful console commands:

```js
await window.LUMIVERSE_QUICKTOOLBAR_MARK('dock-fill-on')
window.LUMIVERSE_QUICKTOOLBAR_RUNS
```

The report includes runtime asset hashes, service-worker/cache state, API and
React settings, the complete geometry chain, action rectangles, first broken
boundary, transition label, and a primary failure classification.

The artifact check requires a valid `lumiverse-<timestamp>` build marker and
at least one loaded hashed index JavaScript/CSS asset. Missing markers or assets
are reported as stale runtime rather than a layout pass.
