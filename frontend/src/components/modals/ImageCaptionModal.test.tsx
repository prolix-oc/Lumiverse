import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const closeModal = jest.fn()
const setImageGenSettings = jest.fn()

const storeState = {
  activeModal: 'imageCaptioner',
  closeModal,
  imageGeneration: {
    captionPrompt: 'Stored caption instructions',
    promptPresets: [],
  },
  setImageGenSettings,
  activeCharacterId: null,
  characters: [],
  activePersonaId: null,
  personas: [],
}

mock.module('@/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))
mock.module('@/api/image-gen', () => ({ imageGenApi: { caption: jest.fn() } }))
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: jest.fn() }))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarUrl: () => null,
  getPersonaAvatarUrl: () => null,
}))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const { createRoot } = await import('react-dom/client') as { createRoot: typeof CreateRoot }
const { default: ImageCaptionModal } = await import('./ImageCaptionModal')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  closeModal.mockReset()
  setImageGenSettings.mockReset()
  jest.useFakeTimers()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  jest.useRealTimers()
})

async function renderModal() {
  await act(async () => { root.render(<ImageCaptionModal />) })
  return host.querySelector<HTMLTextAreaElement>('textarea')!
}

async function editPrompt(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

describe('ImageCaptionModal prompt persistence', () => {
  test('loads the saved per-user prompt and commits edits after a debounce', async () => {
    const textarea = await renderModal()
    expect(textarea.value).toBe('Stored caption instructions')

    await editPrompt(textarea, 'First draft')
    await editPrompt(textarea, 'Final caption instructions')
    await act(async () => { jest.advanceTimersByTime(499) })
    expect(setImageGenSettings).not.toHaveBeenCalled()

    await act(async () => { jest.advanceTimersByTime(1) })
    expect(setImageGenSettings).toHaveBeenCalledTimes(1)
    expect(setImageGenSettings).toHaveBeenCalledWith({ captionPrompt: 'Final caption instructions' })
  })

  test('flushes an edit when the modal closes before the debounce expires', async () => {
    const textarea = await renderModal()
    await editPrompt(textarea, 'Keep this prompt')

    const closeButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Close')!
    await act(async () => { closeButton.click() })

    expect(setImageGenSettings).toHaveBeenCalledTimes(1)
    expect(setImageGenSettings).toHaveBeenCalledWith({ captionPrompt: 'Keep this prompt' })
    expect(closeModal).toHaveBeenCalledTimes(1)
  })
})
