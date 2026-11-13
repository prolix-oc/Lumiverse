import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const getCharacter = jest.fn()
const listHiddenFromRecent = jest.fn()
const patchMetadata = jest.fn()
const closeModal = jest.fn()
const setSetting = jest.fn()
const translate = (key: string) => key === 'hiddenFromHome.missingCharacter' ? 'Unknown character' : key

const storeState = {
  closeModal,
  characters: [],
  landingHiddenCharacterIds: ['character-1'],
  setSetting,
}
mock.module('@/hooks/useCharacterCatalog', () => ({ useCharacterCatalog: () => storeState.characters }))

mock.module('@/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))
mock.module('@/api/characters', () => ({ charactersApi: { get: getCharacter } }))
mock.module('@/api/chats', () => ({ chatsApi: { listHiddenFromRecent, patchMetadata } }))
mock.module('@/lib/toast', () => ({ toast: { error: jest.fn() } }))
mock.module('@/lib/formatRelativeTime', () => ({ formatRelativeTime: () => '' }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))

const { default: HiddenFromHomeModal } = await import('./HiddenFromHomeModal')

let dom: JSDOM
let host: HTMLDivElement
let root: Root
let previousGlobals: Record<string, unknown>

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previousGlobals = Object.fromEntries(
    ['window', 'document', 'HTMLElement', 'Node', 'Event', 'IS_REACT_ACT_ENVIRONMENT']
      .map((key) => [key, Reflect.get(globalThis, key)]),
  )
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  listHiddenFromRecent.mockReset().mockResolvedValue([])
  patchMetadata.mockReset().mockResolvedValue(undefined)
  getCharacter.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  dom.window.close()
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
})

describe('HiddenFromHomeModal', () => {
  test('resolves the name of a hidden character missing from the character store', async () => {
    getCharacter.mockResolvedValue({ id: 'character-1', name: 'Selene' })

    await act(async () => { root.render(<HiddenFromHomeModal />) })

    expect(getCharacter).toHaveBeenCalledWith('character-1')
    expect(document.body.textContent).toContain('Selene')
    expect(document.body.textContent).not.toContain('Unknown character')
  })
})
