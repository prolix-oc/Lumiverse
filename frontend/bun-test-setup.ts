// Test-environment shims loaded via bunfig.toml [test] preload.
//
// Newer tests (placement-helper, containers, spindle-placement) import
// modules that transitively touch `window`, `document`, and `localStorage`
// at module-load time. Bun's test runtime does not provide DOM globals
// by default, so we shim them here. The shims are no-ops if the globals
// are already defined (e.g. when run under a DOM test env).

class TestNode {}

class TestElement extends TestNode {
  readonly style: Record<string, string> = {}
  readonly children: TestElement[] = []
  readonly attributes = new Map<string, string>()
  parentElement: TestElement | null = null

  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  hasAttribute(name: string) { return this.attributes.has(name) }
  removeAttribute(name: string) { this.attributes.delete(name) }
  appendChild(child: TestElement) { child.parentElement = this; this.children.push(child); return child }
  removeChild(child: TestElement) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentElement = null
    return child
  }
  replaceChildren(...children: TestElement[]) {
    for (const child of this.children) child.parentElement = null
    this.children.splice(0, this.children.length)
    for (const child of children) this.appendChild(child)
  }
  addEventListener() {}
  removeEventListener() {}
  contains(child: TestElement) { return child === this || this.children.includes(child) }
  get firstChild() { return this.children[0] ?? null }
}

if (typeof (globalThis as any).window === 'undefined') {
  const testWindow = new EventTarget() as EventTarget & Record<string, any>
  Object.assign(testWindow, {
    location: { protocol: 'http:', host: 'localhost' },
    matchMedia: (media: string) => ({
      addEventListener() {},
      addListener() {},
      dispatchEvent: () => false,
      matches: false,
      media,
      onchange: null,
      removeEventListener() {},
      removeListener() {},
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
  ;(globalThis as any).window = testWindow
}

if (typeof (globalThis as any).document === 'undefined') {
  ;(globalThis as any).document = {
    createElement: (_tag: string) => new TestElement(),
  }
}

if (typeof (globalThis as any).Node === 'undefined') (globalThis as any).Node = TestNode
if (typeof (globalThis as any).Element === 'undefined') (globalThis as any).Element = TestElement
if (typeof (globalThis as any).HTMLElement === 'undefined') (globalThis as any).HTMLElement = TestElement

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
