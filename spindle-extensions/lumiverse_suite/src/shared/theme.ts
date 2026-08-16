const themeBridgeCss = `:root {
  --lumiverse-suite-surface: var(--lumiverse-bg, #1c1826);
  --lumiverse-suite-surface-elevated: var(--lumiverse-bg-elevated, #231e30);
  --lumiverse-suite-surface-hover: var(--lumiverse-bg-hover, #2d283a);
  --lumiverse-suite-text: var(--lumiverse-text, rgba(255, 255, 255, 0.9));
  --lumiverse-suite-text-muted: var(--lumiverse-text-muted, rgba(255, 255, 255, 0.65));
  --lumiverse-suite-accent: var(--lumiverse-primary, #9370db);
  --lumiverse-suite-accent-hover: var(--lumiverse-primary-hover, #a784ef);
  --lumiverse-suite-border: var(--lumiverse-border, rgba(147, 112, 219, 0.12));
  --lumiverse-suite-radius: var(--lumiverse-radius, 8px);
  --lumiverse-suite-shadow: var(--lumiverse-shadow, 0 4px 6px -1px rgba(0, 0, 0, 0.3));
  --lumiverse-suite-transition: var(--lumiverse-transition, 200ms ease);
  --lumiverse-suite-font-family: var(--lumiverse-font-family, sans-serif);
}`

type ThemeBridgeEntry = {
  dispose: () => void
  references: number
}

const bridges = new WeakMap<object, ThemeBridgeEntry>()
const globalBridgeKey: object = {}

/**
 * Installs suite-only tokens that follow the host's active theme. The returned
 * disposer is idempotent and removes the bridge after its final owner stops.
 */
export function installThemeBridge(addStyle: (css: string) => () => void, owner: object = globalBridgeKey): () => void {
  let bridge = bridges.get(owner)

  if (!bridge) {
    bridge = { dispose: addStyle(themeBridgeCss), references: 0 }
    bridges.set(owner, bridge)
  }

  bridge.references += 1
  let disposed = false

  return () => {
    if (disposed) return
    disposed = true
    bridge.references -= 1
    if (bridge.references > 0) return
    bridge.dispose()
    bridges.delete(owner)
  }
}

export const THEME_BRIDGE_CSS = themeBridgeCss
