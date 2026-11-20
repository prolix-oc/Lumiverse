import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { subscribeWindowFileImport } from '@/lib/window-file-import'

const openedTabs: string[] = []
mock.module('@/store', () => ({ useStore: { getState: () => ({ openDrawer: (tab: string) => openedTabs.push(tab) }) } }))
mock.module('@/lib/toast', () => ({ toast: { error: () => {} } }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }))

const { default: WindowFileDropHost } = await import('./WindowFileDropHost')

let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previousGlobals: Record<string, unknown>

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previousGlobals = Object.fromEntries(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Reflect.get(globalThis, key)]),
  )
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  openedTabs.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<WindowFileDropHost />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
})

function dropOn(target: EventTarget, files: File[]): Event {
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  target.dispatchEvent(event)
  return event
}

test('a file dropped on the window reaches the importer even with no tab open', async () => {
  const card = new File(['image'], 'card.png')
  const received: File[][] = []
  const unsubscribe = subscribeWindowFileImport('character', (files) => { received.push(files) })

  await act(async () => { dropOn(window, [card]) })

  expect(openedTabs).toEqual(['characters'])
  expect(received).toEqual([[card]])
  unsubscribe()
})

test('a handled drop stays with its local drop target', async () => {
  const localTarget = document.createElement('div')
  document.body.append(localTarget)
  localTarget.addEventListener('drop', (event) => event.preventDefault())

  await act(async () => { dropOn(localTarget, [new File(['image'], 'card.png')]) })

  expect(openedTabs).toEqual([])
})

test('a preset drop opens Loom and waits for its importer to mount', async () => {
  const file = new File(['{"blocks":[]}'], 'preset.json')

  await act(async () => { dropOn(window, [file]) })

  expect(openedTabs).toEqual(['loom'])
  const received: File[][] = []
  const unsubscribe = subscribeWindowFileImport('preset', (files) => { received.push(files) })
  expect(received).toEqual([[file]])
  unsubscribe()
})

test('a recognized world book drop opens Lorebook', async () => {
  const file = new File(['{"type":"lumiverse_world_book","entries":[]}'], 'world.json')
  const received: File[][] = []
  const unsubscribe = subscribeWindowFileImport('worldbook', (files) => { received.push(files) })

  await act(async () => { dropOn(window, [file]) })

  expect(openedTabs).toEqual(['lorebook'])
  expect(received).toEqual([[file]])
  unsubscribe()
})

test('an ambiguous JSON drop asks where to import it', async () => {
  const file = new File(['{}'], 'unknown.json')
  const received: File[][] = []
  const unsubscribe = subscribeWindowFileImport('worldbook', (files) => { received.push(files) })

  await act(async () => { dropOn(window, [file]) })
  expect(document.body.textContent).toContain('windowFileDrop.chooseDestination')
  const choice = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('windowFileDrop.worldBooks'))
  await act(async () => { choice?.click() })

  expect(openedTabs).toEqual(['lorebook'])
  expect(received).toEqual([[file]])
  unsubscribe()
})
