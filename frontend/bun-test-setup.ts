// Test-environment shims loaded via bunfig.toml [test] preload.
//
// Newer tests (placement-helper, containers, spindle-placement) import
// modules that transitively touch `window`, `document`, and `localStorage`
// at module-load time. Bun's test runtime does not provide DOM globals
// by default, so we shim them here. The shims are no-ops if the globals
// are already defined (e.g. when run under a DOM test env).

if (typeof (globalThis as any).window === 'undefined') {
  const noop = () => {}
  ;(globalThis as any).window = {
    location: { protocol: 'http:' },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
    CustomEvent: class { constructor(_t: string, init?: any) { this.detail = init?.detail } },
  }
}

if (typeof (globalThis as any).document === 'undefined') {
  ;(globalThis as any).document = {
    createElement(_tag: string) {
      return {
        setAttribute() {},
        style: {} as Record<string, string>,
        appendChild() {},
        removeChild() {},
        replaceChildren() {},
        addEventListener() {},
        removeEventListener() {},
        contains() { return false },
        get firstChild() { return null },
        get parentElement() { return null },
      }
    },
  }
}

if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>()
  const shim = {
    getItem(k: string) { return store.has(k) ? store.get(k)! : null },
    setItem(k: string, v: string) { store.set(k, v) },
    removeItem(k: string) { store.delete(k) },
    clear() { store.clear() },
    key(i: number) { return Array.from(store.keys())[i] ?? null },
    get length() { return store.size },
  }
  ;(globalThis as any).localStorage = shim
}
