import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { playChatChromeMotion } from './chatChromeMotion'

function harness(reducedMotion = false, shell: 'browser' | 'native-ios' | 'pwa-ios' = 'browser') {
  const dom = new JSDOM('<!doctype html><div id="chat"><div data-component="MessageList"></div><div data-component="InputArea"></div></div>')
  const root = dom.window.document.getElementById('chat')!
  if (shell === 'native-ios') dom.window.document.documentElement.setAttribute('data-tauri-mobile', 'ios')
  if (shell === 'pwa-ios') dom.window.document.documentElement.setAttribute('data-ios-pwa', '')
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, { at: number; callback: () => void }>()
  let sequence = 0
  let now = 0
  const animations: Array<{
    frames: Keyframe[]
    finish(): void
    interrupt(): void
    cancelCalls: number
  }> = []
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame(id: number) { frames.delete(id) },
    setTimeout(callback: () => void, delay: number) { timers.set(++sequence, { at: now + delay, callback }); return sequence },
    clearTimeout(id: number) { timers.delete(id) },
  })
  for (const element of root.children) {
    Object.assign(element, {
      animate(keyframes: Keyframe[]) {
        let finish!: () => void
        let reject!: (reason: Error) => void
        const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail })
        const record = { frames: keyframes, finish, interrupt: () => reject(new Error('browser cancelled')), cancelCalls: 0 }
        animations.push(record)
        return {
          finished,
          cancel() { record.cancelCalls++; reject(new Error('cancelled')) },
        }
      },
    })
  }
  return {
    root, animations, frames, timers,
    frame(ms = 16) {
      now += ms
      const batch = [...frames.values()]
      frames.clear()
      for (const callback of batch) callback(now)
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    close() { dom.window.close() },
  }
}

async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve() }

describe('chat chrome playback', () => {
  test('holds the entrance hidden through the paint boundary, then releases every owned style and animation', async () => {
    const h = harness()
    let completed = 0
    const cancel = playChatChromeMotion(h.root, 'enter', () => completed++)
    try {
      expect([...h.root.children].every((element) => (element as HTMLElement).style.opacity === '0')).toBe(true)
      h.frame()
      expect(h.animations.length).toBe(0)
      h.frame()
      expect(h.animations.length).toBe(2)
      expect(h.animations[0].frames[0].opacity).toBe('0')
      expect(h.animations[0].frames[1].opacity).toBe('1')
      h.animations[0].finish()
      await settle()
      expect(completed).toBe(0)
      h.animations[1].finish()
      await settle()
      expect(completed).toBe(1)
      expect([...h.root.children].every((element) => (element as HTMLElement).style.cssText === '')).toBe(true)
      expect(h.animations.every((animation) => animation.cancelCalls === 1)).toBe(true)
      expect(h.timers.size).toBe(0)
    } finally { cancel(); h.close() }
  })

  test('a delayed first paint does not consume the exit duration or navigate before playback finishes', async () => {
    const h = harness()
    let navigations = 0
    const cancel = playChatChromeMotion(h.root, 'leave', () => navigations++)
    try {
      h.advance(350)
      expect(navigations).toBe(0)
      expect(h.animations.length).toBe(0)
      h.frame(); h.frame()
      h.advance(220)
      expect(navigations).toBe(0)
      for (const animation of h.animations) animation.finish()
      await settle()
      expect(navigations).toBe(1)
      h.advance(2000)
      expect(navigations).toBe(1)
    } finally { cancel(); h.close() }
  })

  test('cancels a pending entry before it can start on a different chat', () => {
    const h = harness()
    let completed = 0
    const cancel = playChatChromeMotion(h.root, 'enter', () => completed++)
    cancel()
    h.frame(); h.frame(); h.advance(2000)
    expect(h.animations.length).toBe(0)
    expect(completed).toBe(0)
    expect(h.frames.size).toBe(0)
    expect(h.timers.size).toBe(0)
    h.close()
  })

  test('unmount cancels running playback without navigating and restores authored inline styles', async () => {
    const h = harness()
    const element = h.root.firstElementChild as HTMLElement
    element.style.setProperty('opacity', '.8', 'important')
    element.style.transform = 'scale(.95)'
    element.style.transition = 'background 1s linear'
    const previous = element.style.cssText
    let navigations = 0
    const cancel = playChatChromeMotion(h.root, 'leave', () => navigations++)
    h.frame(); h.frame()
    cancel(); cancel()
    await settle()
    h.advance(2000)
    expect(navigations).toBe(0)
    expect(element.style.cssText).toBe(previous)
    expect(h.animations.every((animation) => animation.cancelCalls === 1)).toBe(true)
    h.close()
  })

  test('reduced motion completes without staging frames or animations', () => {
    const h = harness(true)
    let completed = 0
    playChatChromeMotion(h.root, 'leave', () => completed++)()
    expect(completed).toBe(1)
    expect(h.animations.length).toBe(0)
    expect(h.frames.size).toBe(0)
    expect(h.timers.size).toBe(0)
    h.close()
  })

  test('a stuck animation has bounded recovery and releases its resources', async () => {
    const h = harness()
    let navigations = 0
    const cancel = playChatChromeMotion(h.root, 'leave', () => navigations++)
    h.frame(); h.frame()
    h.advance(2000)
    await settle()
    cancel()
    expect(navigations).toBe(1)
    expect(h.animations.every((animation) => animation.cancelCalls === 1)).toBe(true)
    expect(h.timers.size).toBe(0)
    h.close()
  })

  test('an unavailable animation API cannot strand a chat or navigation', () => {
    const h = harness()
    for (const element of h.root.children) Object.assign(element, { animate: undefined })
    let completed = 0
    const cancel = playChatChromeMotion(h.root, 'leave', () => completed++)
    h.frame(); h.frame()
    expect(completed).toBe(1)
    expect(h.timers.size).toBe(0)
    cancel(); h.close()
  })

  test('missing targets and native creation failures do not trap navigation', () => {
    for (const missing of [true, false]) {
      const h = harness()
      try {
        if (missing) h.root.replaceChildren()
        else for (const element of h.root.children) Object.assign(element, { animate() { throw new DOMException('unavailable', 'NotSupportedError') } })
        let navigations = 0
        playChatChromeMotion(h.root, 'leave', () => navigations++)
        h.frame(); h.frame()
        expect(navigations).toBe(1)
        expect(h.timers.size).toBe(0)
      } finally { h.close() }
    }
  })

  test('browser cancellation completes navigation and releases its resources', async () => {
    const h = harness()
    try {
      let navigations = 0
      playChatChromeMotion(h.root, 'leave', () => navigations++)
      h.frame(); h.frame()
      for (const animation of h.animations) animation.interrupt()
      await settle()
      expect(navigations).toBe(1)
      expect(h.timers.size).toBe(0)
    } finally { h.close() }
  })

  for (const shell of ['native-ios', 'pwa-ios'] as const) {
    test.each(['enter', 'leave'] as const)(`${shell} updates actual styles on frames and completes after the final paint opportunity (%s)`, (direction) => {
      const h = harness(false, shell)
      let completed = 0
      const cancel = playChatChromeMotion(h.root, direction, () => completed++)
      try {
        h.advance(350)
        expect(completed).toBe(0)
        h.frame(); h.frame()
        expect(h.animations).toHaveLength(0)
        h.frame(90)
        const opacity = Number((h.root.firstElementChild as HTMLElement).style.opacity)
        expect(opacity > 0 && opacity < 1).toBe(true)
        expect(completed).toBe(0)
        h.frame(90); h.frame(40)
        expect([...h.root.children].every(element => (element as HTMLElement).style.opacity === (direction === 'enter' ? '1' : '0'))).toBe(true)
        expect(completed).toBe(0)
        h.frame()
        expect(completed).toBe(1)
        expect(h.frames.size).toBe(0)
        expect(h.timers.size).toBe(0)
        expect([...h.root.children].every(element => (element as HTMLElement).style.cssText === '')).toBe(true)
        h.advance(2000)
        expect(completed).toBe(1)
      } finally { cancel(); h.close() }
    })
  }

  test.each([false, true])('iOS frame playback cancellation releases styles and cannot navigate (final-paint=%s)', (finalPaint) => {
    const h = harness(false, 'native-ios')
    const element = h.root.firstElementChild as HTMLElement
    element.style.setProperty('opacity', '.8', 'important')
    element.style.transform = 'scale(.95)'
    element.style.transition = 'background 1s linear'
    const previous = element.style.cssText
    let navigations = 0
    const cancel = playChatChromeMotion(h.root, 'leave', () => navigations++)
    try {
      h.frame(); h.frame(); h.frame(finalPaint ? 220 : 90)
      cancel()
      h.frame(2000); h.advance(2000)
      expect(navigations).toBe(0)
      expect(h.animations).toHaveLength(0)
      expect(h.frames.size).toBe(0)
      expect(h.timers.size).toBe(0)
      expect(element.style.cssText).toBe(previous)
    } finally { cancel(); h.close() }
  })

  test('iOS frame playback honors reduced motion and bounds stalled frame scheduling', () => {
    for (const reduced of [false, true]) {
      const h = harness(reduced, 'pwa-ios')
      try {
        let completed = 0
        playChatChromeMotion(h.root, 'leave', () => completed++)
        h.advance(1600)
        h.frame()
        expect(completed).toBe(1)
        expect(h.animations).toHaveLength(0)
        expect(h.frames.size).toBe(0)
        expect(h.timers.size).toBe(0)
        expect([...h.root.children].every(element => (element as HTMLElement).style.cssText === '')).toBe(true)
      } finally { h.close() }
    }
  })
})
