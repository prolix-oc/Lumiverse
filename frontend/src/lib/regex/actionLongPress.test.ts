import { afterEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  attachRegexActionLongPress,
  type RegexActionLongPressController,
} from './actionLongPress'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })

const TEST_LONG_PRESS_MS = 20
const TEST_GRACE_MS = 120
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
  container: HTMLElement
  action: HTMLElement
  otherAction: HTMLElement
  queued: Element[]
  delegatedClicks: number
  delegatedContextMenus: number
  queueable: boolean
  controller: RegexActionLongPressController
  destroy(): void
}

function findActionTarget(event: Event): Element | null {
  return event.composedPath().find((node): node is Element => (
    node instanceof dom.window.Element && node.hasAttribute('data-lumiverse-regex-action')
  )) ?? null
}

function createController(
  harness: Harness,
  graceWindowMs = TEST_GRACE_MS,
): RegexActionLongPressController {
  return attachRegexActionLongPress({
    container: harness.container,
    findTarget: findActionTarget,
    isQueueable: () => harness.queueable,
    onQueue: (target) => { harness.queued.push(target) },
    longPressMs: TEST_LONG_PRESS_MS,
    movementSlopPx: 12,
    graceWindowMs,
  })
}

function createHarness({ graceWindowMs = TEST_GRACE_MS }: { graceWindowMs?: number } = {}): Harness {
  const document = dom.window.document
  const container = document.createElement('div')
  const action = document.createElement('button')
  action.setAttribute('data-lumiverse-regex-action', `encoded-${Math.random()}`)
  const otherAction = document.createElement('button')
  otherAction.setAttribute('data-lumiverse-regex-action', `other-${Math.random()}`)
  container.append(action, otherAction)
  document.body.append(container)

  const harness: Harness = {
    container,
    action,
    otherAction,
    queued: [],
    delegatedClicks: 0,
    delegatedContextMenus: 0,
    queueable: true,
    controller: null as unknown as RegexActionLongPressController,
    destroy: () => {
      harness.controller?.destroy()
      container.remove()
    },
  }

  harness.controller = createController(harness, graceWindowMs)

  const delegated = (event: Event) => {
    const target = findActionTarget(event)
    if (harness.controller.shouldSuppressEvent(event, target)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (event.type === 'click') harness.delegatedClicks += 1
    if (event.type === 'contextmenu') harness.delegatedContextMenus += 1
  }

  container.addEventListener('click', delegated)
  container.addEventListener('contextmenu', delegated)

  return harness
}

function pointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: {
    pointerType?: string
    isPrimary?: boolean
    pointerId?: number
    clientX?: number
    clientY?: number
  } = {},
): Event {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  })
  Object.defineProperties(event, {
    pointerType: { value: init.pointerType ?? 'touch' },
    isPrimary: { value: init.isPrimary ?? true },
    pointerId: { value: init.pointerId ?? 1 },
  })
  return event
}

function clickEvent(): Event {
  return new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
}

function contextmenuEvent(): Event {
  return new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true })
}

const harnesses: Harness[] = []
const track = (harness: Harness): Harness => {
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.destroy()
})

describe('regex action long-press queue gesture', () => {
  test('queues once and suppresses contextmenu while the finger remains held', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    await wait(TEST_LONG_PRESS_MS + 10)

    expect(harness.queued).toEqual([harness.action])

    harness.action.dispatchEvent(contextmenuEvent())
    harness.action.dispatchEvent(contextmenuEvent())

    expect(harness.queued).toHaveLength(1)
    expect(harness.delegatedContextMenus).toBe(0)
  })

  test('suppresses a contextmenu that races the hold timer', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    harness.action.dispatchEvent(contextmenuEvent())

    expect(harness.delegatedContextMenus).toBe(0)
    expect(harness.queued).toHaveLength(0)

    await wait(TEST_LONG_PRESS_MS + 10)
    expect(harness.queued).toEqual([harness.action])
  })

  test('suppresses release click and trailing contextmenu after a successful hold', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    await wait(TEST_LONG_PRESS_MS + 10)
    harness.action.dispatchEvent(pointerEvent('pointerup'))

    harness.action.dispatchEvent(clickEvent())
    harness.action.dispatchEvent(contextmenuEvent())

    expect(harness.queued).toHaveLength(1)
    expect(harness.delegatedClicks).toBe(0)
    expect(harness.delegatedContextMenus).toBe(0)
  })

  test('consumed suppression survives controller teardown and re-attachment', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    await wait(TEST_LONG_PRESS_MS + 10)
    expect(harness.queued).toHaveLength(1)

    harness.controller.destroy()
    harness.controller = createController(harness)

    harness.action.dispatchEvent(contextmenuEvent())
    harness.action.dispatchEvent(clickEvent())

    expect(harness.queued).toHaveLength(1)
    expect(harness.delegatedContextMenus).toBe(0)
    expect(harness.delegatedClicks).toBe(0)
  })

  test('pointercancel after firing is not treated as physical release', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown', { pointerId: 4 }))
    await wait(TEST_LONG_PRESS_MS + 10)
    harness.action.dispatchEvent(pointerEvent('pointercancel', { pointerId: 4 }))
    await wait(TEST_GRACE_MS + 40)

    harness.action.dispatchEvent(contextmenuEvent())

    expect(harness.queued).toHaveLength(1)
    expect(harness.delegatedContextMenus).toBe(0)
  })

  test('short tap stays on the normal click path', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    harness.action.dispatchEvent(pointerEvent('pointerup'))
    await wait(TEST_LONG_PRESS_MS + 10)
    harness.action.dispatchEvent(clickEvent())

    expect(harness.queued).toHaveLength(0)
    expect(harness.delegatedClicks).toBe(1)
  })

  test('movement beyond slop cancels the hold', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
    harness.action.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 0 }))
    await wait(TEST_LONG_PRESS_MS + 10)
    harness.action.dispatchEvent(contextmenuEvent())

    expect(harness.queued).toHaveLength(0)
    expect(harness.delegatedContextMenus).toBe(1)
  })

  test('movement within slop keeps the hold alive', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
    harness.action.dispatchEvent(pointerEvent('pointermove', { clientX: 5, clientY: 5 }))
    await wait(TEST_LONG_PRESS_MS + 10)

    expect(harness.queued).toEqual([harness.action])
  })

  test('pointercancel before firing cancels the hold', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    harness.action.dispatchEvent(pointerEvent('pointercancel'))
    await wait(TEST_LONG_PRESS_MS + 10)
    harness.action.dispatchEvent(clickEvent())

    expect(harness.queued).toHaveLength(0)
    expect(harness.delegatedClicks).toBe(1)
  })

  test('mouse, secondary pointers, and non-queueable actions never arm', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse' }))
    harness.action.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, isPrimary: false }))

    harness.queueable = false
    harness.action.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3 }))

    await wait(TEST_LONG_PRESS_MS + 10)

    expect(harness.queued).toHaveLength(0)
  })

  test('suppression is scoped to the held action', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    await wait(TEST_LONG_PRESS_MS + 10)

    harness.otherAction.dispatchEvent(contextmenuEvent())

    expect(harness.queued).toHaveLength(1)
    expect(harness.delegatedContextMenus).toBe(1)
  })

  test('a fresh primary press clears stale consumed state', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
    await wait(TEST_LONG_PRESS_MS + 10)
    harness.action.dispatchEvent(pointerEvent('pointercancel', { pointerId: 1 }))
    harness.action.dispatchEvent(contextmenuEvent())
    expect(harness.delegatedContextMenus).toBe(0)

    harness.action.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2 }))
    harness.action.dispatchEvent(pointerEvent('pointerup', { pointerId: 2 }))
    harness.action.dispatchEvent(clickEvent())

    expect(harness.queued).toHaveLength(1)
    expect(harness.delegatedClicks).toBe(1)
  })

  test('destroy before the timer fires clears pending state', async () => {
    const harness = track(createHarness())

    harness.action.dispatchEvent(pointerEvent('pointerdown'))
    harness.controller.destroy()
    await wait(TEST_LONG_PRESS_MS + 10)

    harness.controller = createController(harness)
    harness.action.dispatchEvent(clickEvent())
    harness.action.dispatchEvent(contextmenuEvent())

    expect(harness.queued).toHaveLength(0)
    expect(harness.delegatedClicks).toBe(1)
    expect(harness.delegatedContextMenus).toBe(1)
  })
})
