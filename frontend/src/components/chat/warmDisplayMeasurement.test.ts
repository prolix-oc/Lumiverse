import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createWarmDisplayMeasurementQueue } from './warmDisplayMeasurement'

test('releases a pending display reservation when streaming takes over without displayReady', async () => {
  const dom = new JSDOM('<article><div data-display-pending></div></article>')
  const row = dom.window.document.querySelector<HTMLElement>('article')!
  let height = 1200
  Object.defineProperty(row, 'offsetHeight', { get: () => height })
  const committed: number[] = []
  const queue = createWarmDisplayMeasurementQueue(element => committed.push(element.offsetHeight))
  try {
    queue.begin(row, 1000)
    expect(queue.measure(row)).toBe(1000)
    await Bun.sleep(220)
    expect(committed).toEqual([]) // Pending work has no settling deadline yet.

    row.firstElementChild!.removeAttribute('data-display-pending')
    expect(queue.measure(row)).toBe(1000)
    const deadline = performance.now() + 1500
    while (committed.length === 0 && performance.now() < deadline) await Bun.sleep(20)
    expect(committed).toEqual([1200])
    expect(queue.measure(row)).toBeUndefined()

    // Subsequent stream growth is measured normally rather than held forever.
    height = 1800
    expect(queue.measure(row)).toBeUndefined()
  } finally {
    queue.dispose()
    dom.window.close()
  }
})
