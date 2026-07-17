import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import panels from '../../../i18n/locales/en/panels.json'
import shared from '../../../i18n/locales/en/shared.json'
import type { ImageGenConnectionModelsResult, ImageGenConnectionProfile } from '../../../types/api'

let createRoot: typeof CreateRoot
let CharacterLoraTab: (props: { characterId: string }) => ReactNode

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

if (!domWindow.PointerEvent) {
  class TestPointerEvent extends domWindow.MouseEvent {}
  Object.assign(domWindow, { PointerEvent: TestPointerEvent })
  Object.assign(globalThis, { PointerEvent: TestPointerEvent })
}

if (!globalThis.ResizeObserver) {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
}

if (!domWindow.HTMLElement.prototype.scrollIntoView) {
  domWindow.HTMLElement.prototype.scrollIntoView = () => {}
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const modelsBySubtype = jest.fn<
  (id: string, subtype: string) => Promise<ImageGenConnectionModelsResult>
>()
const getImageGenLora = jest.fn(() => Promise.resolve({ binding: null }))
const setImageGenLora = jest.fn()
const deleteImageGenLora = jest.fn()

let storeState: {
  imageGenProfiles: ImageGenConnectionProfile[]
  activeImageGenConnectionId: string | null
} = {
  imageGenProfiles: [],
  activeImageGenConnectionId: null,
}

mock.module('@/api/characters', () => ({
  charactersApi: {
    getImageGenLora,
    setImageGenLora,
    deleteImageGenLora,
  },
}))
mock.module('@/api/image-gen-connections', () => ({
  imageGenConnectionsApi: { modelsBySubtype },
}))
mock.module('@/store', () => ({
  useStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}))

const englishI18n = createInstance()
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

function sdApiProfile(): ImageGenConnectionProfile {
  return {
    id: 'sdapi-connection',
    name: 'SD API test connection',
    provider: 'sdapi',
    api_url: 'http://sdapi.example.test',
    model: '',
    is_default: false,
    has_api_key: false,
    default_parameters: {},
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }
}

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })

  await act(async () => {
    root.render(<I18nextProvider i18n={englishI18n}>{node}</I18nextProvider>)
    await Promise.resolve()
  })

  return host
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settleDeferred<T>(deferred: Deferred<T>, value: T) {
  await act(async () => {
    deferred.resolve(value)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await englishI18n.use(initReactI18next).init({
    resources: { en: { panels, shared } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

  // dnd-kit and ReactDOM must evaluate after JSDOM installs browser globals.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: CharacterLoraTab } = await import('./CharacterLoraTab'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()
  modelsBySubtype.mockReset()
  getImageGenLora.mockReset()
  setImageGenLora.mockReset()
  deleteImageGenLora.mockReset()
  storeState = { imageGenProfiles: [], activeImageGenConnectionId: null }
})

function findButtonByText(host: HTMLDivElement, text: string) {
  return Array.from(host.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  )
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus()
    const descriptor = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')
    descriptor?.set?.call(input, value)
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true, cancelable: true }))
    await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0))
  })
}

describe('CharacterLoraTab SD API guidance', () => {
  test('treats SD API as discoverable, renders accurate guidance, and exposes the exact discovered filename', async () => {
    const profile = sdApiProfile()
    const discovery = createDeferred<ImageGenConnectionModelsResult>()
    storeState = {
      imageGenProfiles: [profile],
      activeImageGenConnectionId: profile.id,
    }
    getImageGenLora.mockResolvedValue({ binding: null })
    modelsBySubtype.mockReturnValue(discovery.promise)

    const host = await mount(<CharacterLoraTab characterId="character-sdapi" />)

    expect(modelsBySubtype).toHaveBeenCalledTimes(1)
    expect(modelsBySubtype).toHaveBeenCalledWith(profile.id, 'loras')
    expect(getImageGenLora).toHaveBeenCalledWith('character-sdapi')

    await settleDeferred(discovery, {
      provider: 'sdapi',
      models: [{ id: 'styles/ink.safetensors', label: 'Ink' }],
    })

    const expectedLoraHelper =
      "Spliced into the active ComfyUI workflow's LoraLoader node, sent as SwarmUI loras/loraweights parameters, or sent to SD API as a LoRA path and model-strength multiplier. Other providers ignore this field but still see the base tags below."
    const expectedStrengthHelper =
      'Typical range is 0–1. ComfyUI applies model and CLIP strengths separately; SwarmUI uses only the model strength, and SD API sends it as the LoRA multiplier.'
    const expectedBaseTagsHelper =
      'Prepended to image prompts for this character while its Character LoRA layer is active and not bypassed. Booru-style tags work best (lowercase, underscores).'
    expect(panels.characterEditor.imageLora.loraHelper).toBe(expectedLoraHelper)
    expect(panels.characterEditor.imageLora.strengthHelper).toBe(expectedStrengthHelper)
    expect(panels.characterEditor.imageLora.baseTagsHelper).toBe(expectedBaseTagsHelper)

    const text = host.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const expectRenderedCopy = (key: string, expected: string) => {
      expect(text.includes(expected) || text.includes(key)).toBe(true)
    }
    expectRenderedCopy('characterEditor.imageLora.loraHelper', expectedLoraHelper)
    expectRenderedCopy('characterEditor.imageLora.strengthHelper', expectedStrengthHelper)
    expectRenderedCopy('characterEditor.imageLora.baseTagsHelper', expectedBaseTagsHelper)
    expectRenderedCopy('imageGenPanel.loraDiscoveryReady', '1 LoRA loaded')
    expect(text).not.toContain('LoRA discovery is only available for ComfyUI and SwarmUI connections.')

    const picker = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
    expect(picker).not.toBeNull()
    expect(picker?.disabled).toBe(false)
    await click(picker!)

    const discoveredOption = document.querySelector<HTMLButtonElement>('button[role="option"]')
    expect(discoveredOption).not.toBeNull()
    expect(discoveredOption?.textContent).toContain('Ink')
    await click(discoveredOption!)

    const manualFilename = Array.from(host.querySelectorAll<HTMLInputElement>('input'))
      .find((input) => input.type === 'text')
    expect(manualFilename?.value).toBe('styles/ink.safetensors')
  })

  test('saving with an empty LoRA name deletes the existing binding', async () => {
    const profile = sdApiProfile()
    const discovery = createDeferred<ImageGenConnectionModelsResult>()
    storeState = {
      imageGenProfiles: [profile],
      activeImageGenConnectionId: profile.id,
    }
    getImageGenLora.mockResolvedValue({
      binding: {
        lora_name: 'old.safetensors',
        weight_model: 0.8,
        weight_clip: 0.7,
        bound_at: 1,
      },
    })
    deleteImageGenLora.mockResolvedValue({ success: true })
    modelsBySubtype.mockReturnValue(discovery.promise)

    const host = await mount(<CharacterLoraTab characterId="character-clear" />)
    await settleDeferred(discovery, { provider: 'sdapi', models: [] })

    const manualFilename = Array.from(host.querySelectorAll<HTMLInputElement>('input')).find(
      (input) => input.type === 'text',
    )
    expect(manualFilename?.value).toBe('old.safetensors')

    await typeInto(manualFilename!, '')

    const saveBtn = findButtonByText(host, 'Update')
    expect(saveBtn).not.toBeUndefined()
    await click(saveBtn!)

    expect(deleteImageGenLora).toHaveBeenCalledWith('character-clear')
    expect(setImageGenLora).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Cleared.')
  })
})
