import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { JSDOM } from 'jsdom'
import chatTranslations from '@/i18n/locales/en/chat.json'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lumiverse.test/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const previousGlobals = new Map(
  ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'navigator', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, globalObject[key]]),
)
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})

mock.module('./MessageSelectCheckbox.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const i18n = createInstance()
let createRoot: typeof CreateRoot
let MessageSelectCheckbox: typeof import('./MessageSelectCheckbox').default
let root: Root | null = null

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    resources: { en: { chat: chatTranslations } },
    interpolation: { escapeValue: false },
  })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: MessageSelectCheckbox } = await import('./MessageSelectCheckbox'))
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globalObject, key)
    else Reflect.set(globalObject, key, value)
  }
  dom.window.close()
})

interface RenderOptions {
  index?: number
  name?: string
  content?: string
  checked?: boolean
  onToggle?: (e: React.MouseEvent) => void
  /** Mirrors the message card, which also toggles selection when clicked. */
  onCardClick?: () => void
}

async function render(options: RenderOptions = {}): Promise<HTMLInputElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <div onClick={options.onCardClick}>
          <MessageSelectCheckbox
            index={options.index ?? 3}
            name={options.name ?? 'Buffy'}
            content={options.content ?? 'Hello there'}
            checked={options.checked ?? false}
            onToggle={options.onToggle}
          />
        </div>
      </I18nextProvider>,
    )
  })
  const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(input).not.toBeNull()
  return input!
}

describe('MessageSelectCheckbox', () => {
  test('is a real checkbox named after its message', async () => {
    const input = await render()
    // Without a name the box focuses silently and a screen reader cannot say
    // which message it belongs to.
    expect(input.getAttribute('aria-label')).toBe('Select message 3 from Buffy: Hello there')
  })

  test('reports the selected state', async () => {
    expect((await render({ checked: false })).checked).toBe(false)
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    expect((await render({ checked: true })).checked).toBe(true)
  })

  test('folds a short, single-line preview into the name', async () => {
    const input = await render({ content: '  Spike   said\n\n  nothing  ' })
    expect(input.getAttribute('aria-label')).toBe('Select message 3 from Buffy: Spike said nothing')
  })

  test('truncates a long message instead of reading the whole turn', async () => {
    const input = await render({ content: 'x'.repeat(500) })
    expect(input.getAttribute('aria-label')).toBe(`Select message 3 from Buffy: ${'x'.repeat(60)}`)
  })

  test('drops the preview when the message has no text', async () => {
    const input = await render({ content: '   \n  ' })
    expect(input.getAttribute('aria-label')).toBe('Select message 3 from Buffy')
  })

  test('toggling reaches the handler exactly once', async () => {
    const onToggle = mock(() => {})
    const onCardClick = mock(() => {})
    const input = await render({ onToggle, onCardClick })

    await act(async () => { input.click() })

    expect(onToggle).toHaveBeenCalledTimes(1)
    // The card toggles on click as well; if the click bubbled, the two handlers
    // would cancel each other out and selection would never stick.
    expect(onCardClick).toHaveBeenCalledTimes(0)
  })

  test('forwards the modifier state so range selection still works', async () => {
    const shiftKeys: unknown[] = []
    const input = await render({ onToggle: (e) => shiftKeys.push(e.shiftKey) })

    await act(async () => {
      input.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
    })

    expect(shiftKeys).toEqual([true])
  })
})
