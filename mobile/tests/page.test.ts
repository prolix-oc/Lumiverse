import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../shared/page.js', import.meta.url), 'utf8')
function page(direction: number, options: { editable?: boolean; modal?: boolean; hidden?: boolean; missing?: boolean; viewport?: number } = {}) {
  const calls: unknown[] = []
  const events: unknown[] = []
  const chat = {
    clientHeight: 800,
    dispatchEvent: (event: unknown) => events.push(event),
    getClientRects: () => options.hidden ? [] : [{}],
    scrollBy: (value: unknown) => calls.push(value),
  }
  const result = runInNewContext(script.replace('__DIRECTION__', String(direction)), {
    getComputedStyle: () => ({ visibility: 'visible' }),
    WheelEvent: class { constructor(public type: string, public init: unknown) {} },
    document: {
      activeElement: { closest: () => options.editable ? {} : null },
      querySelector: () => options.modal ? {} : null,
      querySelectorAll: (selector: string) => selector.includes('dialog')
        ? (options.modal ? [chat] : []) : (options.missing ? [] : [chat]),
    },
    window: { visualViewport: options.viewport ? { height: options.viewport } : undefined },
  })
  return { result, calls, events }
}

describe('native chat paging', () => {
  test('moves up and down with overlapping pages', () => {
    expect(page(-1).calls).toEqual([{ top: -680, behavior: 'instant' }])
    expect(page(1).calls).toEqual([{ top: 680, behavior: 'instant' }])
  })
  test('signals wheel intent so upward paging cancels auto-follow', () => {
    expect(page(-1).events).toEqual([{ type: 'wheel', init: { deltaY: -680, bubbles: true } }])
    expect(page(1, { editable: true }).events).toHaveLength(1)
  })
  test('uses the visible height when zoomed', () => {
    expect(page(1, { viewport: 400 }).calls).toEqual([{ top: 340, behavior: 'instant' }])
  })
  test('pages with retained composer focus but not behind visible dialogs', () => {
    expect(page(1, { editable: true }).result).toBe('paged')
    expect(page(1, { modal: true }).calls).toEqual([])
  })
  test('ignores missing and hidden chats', () => {
    expect(page(1, { missing: true }).calls).toEqual([])
    expect(page(1, { hidden: true }).calls).toEqual([])
  })
})
