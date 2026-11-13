import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { playChatChromeMotion } from '@/lib/chatChromeMotion'

// Mount the owning controller's actual effects and Home callback in React.
// Keep unrelated editors, networking and extension rendering out of this test.
const source = await Bun.file(new URL('./ChatView.tsx', import.meta.url)).text()
const file = ts.createSourceFile('ChatView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const controller: Record<string, string> = {}
const stateNames = ['chromeEnterTimerRef', 'chromeLoadChatRef', 'chromeReadyChatRef', 'chromeLeaveRequestedRef', 'chromeWasHiddenRef', '[chatChromeEntering, setChatChromeEntering]', '[chatChromeLeaving, setChatChromeLeaving]']
const states: string[] = []
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useLayoutEffect') {
    const text = node.getText(file)
    if (text.includes("document.body.setAttribute('data-chat-chrome-entering'")) controller.load = text
    if (text.includes('const wasHidden = chromeWasHiddenRef.current')) controller.enter = text
    if (text.includes("playChatChromeMotion(chatColumnInnerRef.current, 'leave'")) controller.leave = text
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleNavigateHome') {
    controller.home = `const ${node.getText(file)}`
  }
  if (ts.isVariableDeclaration(node) && stateNames.includes(node.name.getText(file))) {
    states.push(`const ${node.getText(file)}`)
  }
  ts.forEachChild(node, visit)
}
visit(file)
for (const name of ['load', 'enter', 'leave', 'home']) {
  if (!controller[name]) throw new Error(`Chat motion controller missing: ${name}`)
}
if (states.length !== stateNames.length) throw new Error('Chat motion state declarations missing')
const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  function useController(chatId, chatColumnInnerRef, wallpaperTransitioning, completeNavigateHome) {
    const {useLayoutEffect, useRef, useState, useCallback} = React
    ${states.join('\n')}
    ${controller.load}
    ${controller.home}
    ${controller.leave}
    ${controller.enter}
    return {entering: chatChromeEntering, leaving: chatChromeLeaving, home: handleNavigateHome}
  }
`)

async function harness({ reducedMotion = false, strict = false, shell = 'browser' } = {}) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>')
  const view = dom.window as unknown as Window
  if (shell === 'native-ios') view.document.documentElement.setAttribute('data-tauri-mobile', 'ios')
  if (shell === 'pwa-ios') view.document.documentElement.setAttribute('data-ios-pwa', '')
  const globals = { window: view, document: dom.window.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  let sequence = 0
  let now = 0
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, { at: number; callback: () => void }>()
  Object.assign(view, {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame(id: number) { frames.delete(id) },
    setTimeout(callback: () => void, delay: number) { timers.set(++sequence, { at: now + delay, callback }); return sequence },
    clearTimeout(id: number) { timers.delete(id) },
  })
  const animations: Array<{ part: string; from: string; finish(): void; cancelled: boolean }> = []
  Object.assign(dom.window.HTMLElement.prototype, {
    animate(keyframes: Keyframe[]) {
      const { promise: finished, resolve, reject } = Promise.withResolvers<void>()
      const record = { part: this.getAttribute('data-component'), from: String(keyframes[0].opacity), finish: resolve, cancelled: false }
      animations.push(record)
      return { finished, cancel() { record.cancelled = true; reject(new Error('cancelled')) } }
    },
  })
  const state = { activeChatId: 'A', isStreaming: true, paused: false, pauseStreamingForNavigation() { state.paused = true } }
  let navigations = 0
  const completeNavigateHome = () => { navigations++ }
  const deps = {
    React, playChatChromeMotion, window: view, document: dom.window.document,
    CustomEvent: dom.window.CustomEvent,
    CHAT_REVEAL_SETTLE_CAP_MS: 5000, getChatDisplaySettleDiagnostics: () => ({}),
    prefersReducedMotion: () => reducedMotion,
    peekLandingPageSnapshot: () => null, holdImagesForTransition: () => {},
    useStore: { getState: () => state }, console: { warn() {} },
  }
  const useController = new Function(...Object.keys(deps), `${compiled}; return useController`)(...Object.values(deps))
  let current!: { entering: boolean; leaving: boolean; home(): void }
  let suspended = false
  const pending = new Promise(() => {})
  function Interrupt() {
    if (suspended) throw pending
    return null
  }
  function Chat({ chatId, wallpaper }: { chatId: string; wallpaper: boolean }) {
    const element = React.useRef<HTMLDivElement>(null)
    current = useController(chatId, element, wallpaper, completeNavigateHome)
    return <div ref={element} data-entering={current.entering || undefined} data-leaving={current.leaving || undefined}>
      <div data-component="MessageList" /><div data-component="InputArea" />
      <Interrupt />
    </div>
  }
  const root = createRoot(dom.window.document.getElementById('app')!)
  let chatId = 'A'
  let wallpaper = false
  let mounted = true
  const render = async () => {
    await act(async () => {
      const chat = <React.Suspense fallback={<span>Loading</span>}>{mounted ? <Chat chatId={chatId} wallpaper={wallpaper} /> : <span>Home</span>}</React.Suspense>
      root.render(strict ? <React.StrictMode>{chat}</React.StrictMode> : chat)
    })
  }
  await render()
  return {
    animations, frames, timers, state,
    get entering() { return current.entering },
    get navigations() { return navigations },
    opacity(part: string) { return Number(view.document.querySelector<HTMLElement>(`[data-component="${part}"]`)!.style.opacity) },
    async ready(id = chatId) {
      await act(async () => view.dispatchEvent(new dom.window.CustomEvent('lumiverse:chat-items-populated', { detail: { chatId: id } })))
    },
    async frame(ms = 16) {
      now += ms
      await act(async () => {
        const batch = [...frames.values()]
        frames.clear()
        for (const callback of batch) callback(now)
      })
    },
    async finish() { await act(async () => { for (const animation of animations) animation.finish() }) },
    async home() { await act(async () => current.home()) },
    async wallpaper(value: boolean) { wallpaper = value; await render() },
    async chat(value: string) { mounted = true; chatId = value; state.activeChatId = value; await render() },
    async landing() { mounted = false; await render() },
    async rerender() { await render() },
    async suspend() { suspended = true; await render() },
    async resume() { suspended = false; await render() },
    async advance(ms: number) {
      now += ms
      await act(async () => {
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) { timers.delete(id); timer.callback() }
        }
      })
    },
    async close() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

describe('ChatView motion controller', () => {
  test.each([false, true])('current-chat readiness creates both animations once (StrictMode=%s)', async (strict) => {
    const h = await harness({ strict })
    try {
      await h.ready('stale-chat')
      await h.frame(); await h.frame()
      expect(h.entering).toBe(true)
      expect(h.animations).toHaveLength(0)
      await h.ready()
      expect(h.entering).toBe(false)
      await h.frame()
      expect(h.animations).toHaveLength(0)
      await h.frame()
      expect(h.animations.map(({ part }) => part)).toEqual(['MessageList', 'InputArea'])
      await h.finish(); await h.rerender(); await h.ready()
      await h.frame(); await h.frame()
      expect(h.animations).toHaveLength(2)
      expect(h.timers.size).toBe(0)
    } finally { await h.close() }
  })

  test('wallpaper readiness holds playback and switching chats cancels pending frames', async () => {
    const h = await harness()
    try {
      await h.wallpaper(true)
      await h.ready(); await h.frame(); await h.frame()
      expect(h.animations).toHaveLength(0)
      await h.wallpaper(false)
      await h.frame()
      await h.chat('B')
      await h.frame(); await h.frame()
      expect(h.animations).toHaveLength(0)
      await h.ready('A')
      expect(h.entering).toBe(true)
      await h.ready('B'); await h.frame(); await h.frame()
      expect(h.animations).toHaveLength(2)
      await h.finish()
    } finally { await h.close() }
  })

  test('Home cancels entry, freezes streaming, then waits for actual exit completion', async () => {
    const h = await harness()
    try {
      await h.ready(); await h.frame()
      await h.home(); await h.home()
      expect(h.state.paused).toBe(true)
      await h.advance(350)
      expect(h.navigations).toBe(0)
      await h.frame(); await h.frame()
      expect(h.animations.map(({ from }) => from)).toEqual(['1', '1'])
      await h.advance(220)
      expect(h.navigations).toBe(0)
      await h.finish()
      expect(h.navigations).toBe(1)
      await h.advance(2000)
      expect(h.navigations).toBe(1)
    } finally { await h.close() }
  })

  test('runtime reduced motion and missing readiness still reveal the chat', async () => {
    const h = await harness({ reducedMotion: true })
    try {
      await h.advance(6500)
      expect(h.entering).toBe(false)
      expect(h.animations).toHaveLength(0)
      await h.home()
      expect(h.navigations).toBe(1)
      expect(h.frames.size).toBe(0)
    } finally { await h.close() }
  })

  test.each([false, true])('a suspended subtree resumes a cancelled entrance without waiting for a second populated event (running=%s)', async (running) => {
    const h = await harness()
    try {
      await h.ready(); await h.frame()
      if (running) await h.frame()
      await h.suspend()
      expect(h.frames.size).toBe(0)
      await h.resume()
      expect(h.entering).toBe(false)
      await h.frame(); await h.frame()
      expect(h.animations.filter(({ cancelled }) => !cancelled)).toHaveLength(2)
      expect([...h.timers.values()].some(({ at }) => at === 6500)).toBe(false)
      await h.finish()
      expect(h.timers.size).toBe(0)
    } finally { await h.close() }
  })

  test('a completed entrance stays revealed across a layout-effect reconnect', async () => {
    const h = await harness()
    try {
      await h.ready(); await h.frame(); await h.frame(); await h.finish()
      await h.suspend(); await h.resume(); await h.frame(); await h.frame()
      expect(h.entering).toBe(false)
      expect(h.animations).toHaveLength(2)
      expect(h.timers.size).toBe(0)
      expect(h.frames.size).toBe(0)
    } finally { await h.close() }
  })

  test('Home navigation survives an interrupted exit without losing or duplicating navigation', async () => {
    const h = await harness()
    try {
      await h.ready(); await h.frame(); await h.frame(); await h.finish()
      await h.home(); await h.frame(); await h.frame()
      await h.suspend(); await h.resume()
      expect(h.entering).toBe(false)
      await h.home(); await h.frame(); await h.frame()
      expect(h.animations.filter(({ cancelled }) => !cancelled).map(({ from }) => from)).toEqual(['1', '1'])
      expect(h.navigations).toBe(0)
      await h.finish()
      expect(h.navigations).toBe(1)
      expect(h.timers.size).toBe(0)
    } finally { await h.close() }
  })

  test.each(['native-ios', 'pwa-ios'])('iOS Home interrupts entry and waits for the final exit frame (%s)', async (shell) => {
    const h = await harness({ shell })
    try {
      await h.ready(); await h.frame(); await h.frame(); await h.frame(90)
      expect(h.animations).toHaveLength(0)
      expect(h.opacity('InputArea') > 0 && h.opacity('InputArea') < 1).toBe(true)
      await h.home()
      expect(h.state.paused).toBe(true)
      await h.frame(); await h.frame(); await h.frame(90)
      expect(h.opacity('InputArea') > 0 && h.opacity('InputArea') < 1).toBe(true)
      expect(h.navigations).toBe(0)
      await h.frame(130)
      expect(h.opacity('MessageList')).toBe(0)
      expect(h.navigations).toBe(0)
      await h.frame()
      expect(h.navigations).toBe(1)
      expect(h.frames.size).toBe(0)
      expect(h.timers.size).toBe(0)
    } finally { await h.close() }
  })

  test('iOS frame playback resumes after Suspense without another readiness event', async () => {
    const h = await harness({ shell: 'native-ios' })
    try {
      await h.ready(); await h.frame(); await h.frame(); await h.frame(90)
      await h.suspend()
      expect(h.frames.size).toBe(0)
      expect(h.timers.size).toBe(0)
      await h.resume()
      expect(h.entering).toBe(false)
      await h.frame(); await h.frame(); await h.frame(90)
      expect(h.opacity('MessageList') > 0 && h.opacity('MessageList') < 1).toBe(true)
      await h.frame(130); await h.frame()
      expect(h.animations).toHaveLength(0)
      expect(h.frames.size).toBe(0)
      expect(h.timers.size).toBe(0)
    } finally { await h.close() }
  })

  test.each(['native-ios', 'pwa-ios'])('three consecutive chat visits release the previous controller and run every entry/exit (%s)', async (shell) => {
    const h = await harness({ shell })
    try {
      for (const [index, id] of ['A', 'B', 'C'].entries()) {
        await h.chat(id)
        expect(h.entering).toBe(true)
        await h.ready(); await h.frame(); await h.frame(); await h.frame(90)
        expect(h.opacity('MessageList') > 0 && h.opacity('MessageList') < 1).toBe(true)
        await h.frame(130); await h.frame()
        await h.home(); await h.frame(); await h.frame(); await h.frame(90)
        expect(h.opacity('MessageList') > 0 && h.opacity('MessageList') < 1).toBe(true)
        await h.frame(130); await h.frame()
        expect(h.navigations).toBe(index + 1)
        await h.landing()
        expect(h.frames.size).toBe(0)
        expect(h.timers.size).toBe(0)
      }
      expect(h.animations).toHaveLength(0)
    } finally { await h.close() }
  })
})
