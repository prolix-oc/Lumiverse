import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { act, createElement, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

type ConnectionState = {
  isAuthenticated: boolean
  wsConnected: boolean
  wsAuthSynced: boolean
  wsRoundTripVerified: boolean
  wsHasEverConnected: boolean
  wsUpdatePending: boolean
  wsResumeRecovering: boolean
}

const disconnectedState: ConnectionState = {
  isAuthenticated: true,
  wsConnected: false,
  wsAuthSynced: false,
  wsRoundTripVerified: false,
  wsHasEverConnected: true,
  wsUpdatePending: false,
  wsResumeRecovering: false,
}

let storeState = { ...disconnectedState }
const subscribers = new Set<() => void>()

function useTestStore<T>(selector: (state: ConnectionState) => T): T {
  return useSyncExternalStore(
    (subscriber) => {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
    () => selector(storeState),
    () => selector(storeState),
  )
}

mock.module('@/store', () => ({ useStore: useTestStore }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
mock.module('@/components/shared/Spinner', () => ({ Spinner: () => <span>spinner</span> }))
mock.module('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: new Proxy({}, {
    get: (_target, tag: string) => ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) => createElement(tag, props, children),
  }),
}))

const { default: ConnectionLostOverlay } = await import('./ConnectionLostOverlay')

function DesktopWindowHarness() {
  return (
    <>
      <div data-component="DesktopPwaTitlebar">titlebar</div>
      <div data-app-root="">application</div>
      <ConnectionLostOverlay />
    </>
  )
}

let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previousGlobals: Record<string, unknown>

async function setConnectionState(patch: Partial<ConnectionState>) {
  await act(async () => {
    storeState = { ...storeState, ...patch }
    for (const subscriber of subscribers) subscriber()
  })
}

async function advance(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms) })
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previousGlobals = Object.fromEntries(
    ['window', 'document', 'HTMLElement', 'Element', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT']
      .map((key) => [key, Reflect.get(globalThis, key)]),
  )
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  storeState = { ...disconnectedState }
  subscribers.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  jest.useFakeTimers()
})

afterEach(() => {
  act(() => root.unmount())
  jest.useRealTimers()
  dom.window.close()
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
})

describe('ConnectionLostOverlay', () => {
  test('stays latched through refocus recovery while leaving desktop chrome interactive', async () => {
    await act(async () => { root.render(<DesktopWindowHarness />) })
    await advance(5_000)

    const overlay = document.querySelector<HTMLElement>('[role="alertdialog"]')
    const titlebar = document.querySelector<HTMLElement>('[data-component="DesktopPwaTitlebar"]')
    const appRoot = document.querySelector<HTMLElement>('[data-app-root]')
    expect(overlay).not.toBeNull()
    expect(host.hasAttribute('inert')).toBe(false)
    expect(titlebar?.hasAttribute('inert')).toBe(false)
    expect(appRoot?.hasAttribute('inert')).toBe(true)

    const latePortal = document.createElement('div')
    document.body.append(latePortal)
    await act(async () => {})
    expect(latePortal.hasAttribute('inert')).toBe(true)

    const backdropClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
    overlay!.dispatchEvent(backdropClick)
    expect(backdropClick.defaultPrevented).toBe(true)

    await setConnectionState({ wsResumeRecovering: true })
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()

    await setConnectionState({ wsConnected: true, wsAuthSynced: true })
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()

    await setConnectionState({ wsRoundTripVerified: true, wsResumeRecovering: false })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(host.hasAttribute('inert')).toBe(false)
    expect(appRoot?.hasAttribute('inert')).toBe(false)
    expect(latePortal.hasAttribute('inert')).toBe(false)
  })

  test('uses resume recovery only to delay the initial hard-stop', async () => {
    storeState.wsResumeRecovering = true
    await act(async () => { root.render(<DesktopWindowHarness />) })
    await advance(10_000)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()

    await setConnectionState({ wsResumeRecovering: false })
    await advance(4_999)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    await advance(1)
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  })

  test('keeps desktop chrome interactive during an immediate update hard-stop', async () => {
    storeState.wsUpdatePending = true
    await act(async () => { root.render(<DesktopWindowHarness />) })

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(document.querySelector('[data-component="DesktopPwaTitlebar"]')?.hasAttribute('inert')).toBe(false)
    expect(document.querySelector('[data-app-root]')?.hasAttribute('inert')).toBe(true)
  })
})
