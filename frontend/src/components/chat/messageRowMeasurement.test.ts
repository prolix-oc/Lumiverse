import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  createMessageRowRevealQueue,
  MESSAGE_ROW_MEASURING_ATTRIBUTE,
  readMessageRowHeight,
  revealMeasuredMessageRow,
} from './messageRowMeasurement'

function createRows() {
  const dom = new JSDOM('<main><article></article><article></article></main>')
  const rows = [...dom.window.document.querySelectorAll<HTMLElement>('article')]
  for (const row of rows) row.setAttribute(MESSAGE_ROW_MEASURING_ATTRIBUTE, '')
  return { dom, rows }
}

describe('message row reveal measurements', () => {
  test('batches completions after commit, reads all sizes, then sizes each row before revealing it', async () => {
    const { dom, rows: [first, second] } = createRows()
    let secondHeight = 280
    Object.defineProperty(first, 'offsetHeight', { get: () => 320 })
    Object.defineProperty(second, 'offsetHeight', { get: () => secondHeight })
    const resized: Array<{ row: HTMLElement; height: number }> = []
    const queue = createMessageRowRevealQueue((row, height) => {
      expect(row.hasAttribute(MESSAGE_ROW_MEASURING_ATTRIBUTE)).toBe(true)
      resized.push({ row, height })
      secondHeight = 900 // A positioning write must not change the next read.
    })
    queue.schedule(first)
    queue.schedule(first)
    queue.schedule(second)
    expect(resized).toEqual([])
    await Promise.resolve()
    expect(resized).toEqual([{ row: first, height: 320 }, { row: second, height: 280 }])
    expect(first.hasAttribute(MESSAGE_ROW_MEASURING_ATTRIBUTE)).toBe(false)
    expect(second.hasAttribute(MESSAGE_ROW_MEASURING_ATTRIBUTE)).toBe(false)
    queue.dispose()
    dom.window.close()
  })

  test('pending, unmounted and disposed rows cannot be exposed by an old completion', async () => {
    const { dom, rows: [pending, detached] } = createRows()
    pending.innerHTML = '<div data-display-pending>Raw source</div>'
    detached.remove()
    const resized: HTMLElement[] = []
    const queue = createMessageRowRevealQueue(row => { resized.push(row) })
    queue.schedule(pending)
    queue.schedule(detached)
    await Promise.resolve()
    expect(resized).toEqual([])
    revealMeasuredMessageRow(pending)
    expect(pending.hasAttribute(MESSAGE_ROW_MEASURING_ATTRIBUTE)).toBe(true)
    pending.firstElementChild!.removeAttribute('data-display-pending')
    queue.schedule(pending)
    queue.dispose()
    await Promise.resolve()
    expect(resized).toEqual([])
    expect(pending.hasAttribute(MESSAGE_ROW_MEASURING_ATTRIBUTE)).toBe(true)
    dom.window.close()
  })

  test('uses the observed border box or live layout height instead of a stale cached or zoomed height', () => {
    const { dom, rows: [row] } = createRows()
    Object.defineProperty(row, 'offsetHeight', { get: () => 240 })
    row.getBoundingClientRect = () => ({ height: 300 } as DOMRect)
    expect(readMessageRowHeight(row)).toBe(240)
    expect(readMessageRowHeight(row, { borderBoxSize: [{ blockSize: 241.4 }] } as unknown as ResizeObserverEntry)).toBe(241)
    dom.window.close()
  })
})
