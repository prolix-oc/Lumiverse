import { afterEach, beforeAll, describe, expect, jest, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import VirtualGrid from './VirtualGrid'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
let createRoot: typeof CreateRoot
let root: Root
let host: HTMLDivElement
const measureElement = jest.fn()

type Entry = { id: string; imageId: string | null }
const entries: Entry[] = Array.from({ length: 8 }, (_, index) => ({ id: `entry-${index}`, imageId: `image-${index}` }))
const addEntry: Entry = { id: '__add__', imageId: null }

async function render(items: Entry[], columns: number, startRow = 0, endRow = Math.ceil(items.length / columns)) {
  const rows = Array.from({ length: endRow - startRow }, (_, offset) => {
    const index = startRow + offset
    return { index, key: items.slice(index * columns, (index + 1) * columns).map((item) => item.id).join('|'), start: 50 + index * 110 }
  })
  await act(async () => {
    root.render(
      <VirtualGrid
        items={items}
        rows={rows}
        columns={columns}
        gap={10}
        scrollMargin={50}
        getItemKey={(item) => item.id}
        measureElement={measureElement}
        renderItem={(item) => item.imageId
          ? <img src={`/images/${item.imageId}`} alt={item.id} />
          : <button type="button">Add images</button>}
      />,
    )
  })
}

beforeAll(async () => { ({ createRoot } = await import('react-dom/client')) })
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
  measureElement.mockClear()
})

async function mount(items: Entry[], columns: number, startRow?: number, endRow?: number) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await render(items, columns, startRow, endRow)
}

describe('VirtualGrid entry identity', () => {
  test('keeps gallery thumbnails and the add button mounted across row regrouping and resizing', async () => {
    await mount([...entries, addEntry], 3)
    const images = [...host.querySelectorAll('img')]
    const addButton = host.querySelector('button')
    measureElement.mockClear()

    await render([...entries.slice(1), addEntry], 3)

    let survivors = [...host.querySelectorAll('img')]
    expect(survivors).toHaveLength(7)
    expect(survivors.every((image, index) => image === images[index + 1])).toBe(true)
    expect(host.querySelector('button') === addButton).toBe(true)
    const measured = measureElement.mock.calls.map(([element]) => element).filter(Boolean) as HTMLElement[]
    expect(measured.map((element) => element.dataset.index)).toEqual(['0', '1', '2'])

    await render([...entries.slice(1), addEntry], 2)

    survivors = [...host.querySelectorAll('img')]
    expect(survivors.every((image, index) => image === images[index + 1])).toBe(true)
    expect(host.querySelector('button') === addButton).toBe(true)
  })

  test('keeps keys tied to the entry when only its image source changes', async () => {
    await mount(entries, 3)
    const images = [...host.querySelectorAll('img')]
    const sources = images.map((image) => image.getAttribute('src'))
    measureElement.mockClear()

    await render(entries.map((item, index) => index === 3 ? { ...item, imageId: 'replacement' } : item), 3)

    expect([...host.querySelectorAll('img')].every((image, index) => image === images[index])).toBe(true)
    expect(images[3].getAttribute('src')).toBe('/images/replacement')
    for (const index of [0, 1, 2, 4, 5, 6, 7]) expect(images[index].getAttribute('src')).toBe(sources[index])
    expect(measureElement).not.toHaveBeenCalled()
  })

  test('keeps sorting from remounting entries', async () => {
    await mount(entries, 3)
    const images = [...host.querySelectorAll('img')]

    await render([...entries].reverse(), 3)

    const sorted = [...host.querySelectorAll('img')]
    expect(sorted.every((image, index) => image === images[images.length - index - 1])).toBe(true)
  })

  test('mounts only the virtual range and measures rows separately from the image cells', async () => {
    const manyEntries = Array.from({ length: 1000 }, (_, index) => ({ id: `entry-${index}`, imageId: `image-${index}` }))
    await mount(manyEntries, 3, 5, 7)

    expect(host.querySelectorAll('img')).toHaveLength(6)
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('entry-15')
    expect(host.querySelector<HTMLElement>('[data-virtual-grid]')?.style.top).toBe('550px')
    const measured = measureElement.mock.calls.map(([element]) => element).filter(Boolean) as HTMLElement[]
    expect(measured.map((element) => element.dataset.index)).toEqual(['5', '6'])
    expect(measured.every((element) => element.style.gridColumn === '1 / -1')).toBe(true)
    expect(measured.every((element) => element.querySelector('img') === null)).toBe(true)
    expect(host.querySelector('img')?.parentElement?.style.paddingBottom).toBe('10px')
    expect(host.querySelector<HTMLElement>('[data-virtual-grid]')?.style.alignItems).toBe('stretch')
  })
})
