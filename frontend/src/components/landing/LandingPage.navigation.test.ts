import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

// Exercise the owning callbacks with controlled animation completion and IO.
const source = await Bun.file(new URL('./LandingPage.tsx', import.meta.url)).text()
const file = ts.createSourceFile('LandingPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks: Record<string, string> = {}
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
    && ['navigateToChat', 'finishChatNavigation'].includes(node.name.text)
    && ts.isCallExpression(node.initializer)) {
    callbacks[node.name.text] = node.initializer.arguments[0].getText(file)
  }
  if (ts.isJsxAttribute(node) && node.name.getText(file) === 'onAnimationComplete'
    && node.initializer && ts.isJsxExpression(node.initializer)
    && node.initializer.expression?.getText(file).includes('finishChatNavigation')) {
    callbacks.complete = node.initializer.expression.getText(file)
  }
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
    && node.arguments[0]?.getText(file).includes('pendingChatNavigationRef.current = null')) {
    callbacks.unmount = node.arguments[0].getText(file)
  }
  ts.forEachChild(node, visit)
}
visit(file)
const transpiler = new Bun.Transpiler({ loader: 'tsx' })
function create(name: string, deps: Record<string, unknown>) {
  if (!callbacks[name]) throw new Error(`Landing callback missing: ${name}`)
  const js = transpiler.transformSync(`const callback = ${callbacks[name]}`)
  return new Function(...Object.keys(deps), `${js}; return callback`)(...Object.values(deps))
}

function harness(reducedMotion = false) {
  const navigations: string[] = []
  const timers = new Map<number, () => void>()
  const chatReturnInitial = { opacity: 0, y: 10, scale: 0.985 }
  let sequence = 0
  const deps = {
    authUser: null,
    pendingChatNavigationRef: { current: null as string | null },
    chatNavigationTimerRef: { current: null as number | null },
    navigate: (route: string) => navigations.push(route),
    setNavigatingToChat: () => {},
    chatReturnInitial,
    landingEntryAnimating: true,
    setLandingEntryAnimating: () => {},
    CHAT_NAV_COMPLETION_TIMEOUT_MS: 1500,
    window: {
      matchMedia: () => ({ matches: reducedMotion }),
      setTimeout(callback: () => void) { timers.set(++sequence, callback); return sequence },
      clearTimeout(id: number) { timers.delete(id) },
    },
    finishChatNavigation: (() => {}) as () => void,
  }
  deps.finishChatNavigation = create('finishChatNavigation', deps)
  return {
    deps, navigations, timers,
    open: create('navigateToChat', deps),
    complete: create('complete', deps),
    unmount: create('unmount', deps)(),
  }
}

describe('landing route animation completion', () => {
  test('waits for the exit completion and ignores an entrance that finishes during navigation', () => {
    const h = harness()
    h.open('chat-A')
    h.open('chat-B')
    expect(h.navigations).toEqual([])
    expect(h.timers.size).toBe(1)
    h.complete({ opacity: 1, y: 0, scale: 1 })
    expect(h.navigations).toEqual([])
    h.complete(h.deps.chatReturnInitial)
    expect(h.navigations).toEqual(['/chat/chat-A'])
    expect(h.timers.size).toBe(0)
    h.complete(h.deps.chatReturnInitial)
    expect(h.navigations).toHaveLength(1)
  })

  test('a missing completion has recovery without navigating twice on a late callback', () => {
    const h = harness()
    h.open('chat-A')
    for (const callback of [...h.timers.values()]) callback()
    h.complete(h.deps.chatReturnInitial)
    expect(h.navigations).toEqual(['/chat/chat-A'])
    expect(h.timers.size).toBe(0)
  })

  test('unmount invalidates a pending route as well as its timeout', () => {
    const h = harness()
    h.open('chat-A')
    const lateTimeout = [...h.timers.values()][0]
    h.unmount()
    h.complete(h.deps.chatReturnInitial)
    lateTimeout()
    expect(h.navigations).toEqual([])
    expect(h.timers.size).toBe(0)
  })

  test('reduced motion navigates immediately without waiting for an animation callback', () => {
    const h = harness(true)
    h.open('chat-A')
    expect(h.navigations).toEqual(['/chat/chat-A'])
    expect(h.timers.size).toBe(0)
  })
})
