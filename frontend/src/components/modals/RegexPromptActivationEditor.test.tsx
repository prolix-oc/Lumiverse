import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import modals from '@/i18n/locales/en/modals.json'
import type { RegexPromptActivation } from '@/types/regex'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const previewRequests: any[] = []
const insertedTokens: string[] = []
mock.module('@/api/presets', () => ({ presetsApi: { get: async () => ({
  id: 'preset', name: 'Adventure', prompt_order: [
    { id: 'rules', name: 'Combat rules', variables: [{ id: 'mode-id', name: 'mode' }] }, { id: 'format', name: 'Combat format' },
    { id: 'category', name: 'Scene instructions', marker: 'category' },
  ],
}) } }))
mock.module('@/api/regex', () => ({ regexApi: { testActivation: async (input: any) => {
  previewRequests.push(input)
  return { matches: [{ mapping_index: 0, value: 'combat', index: 0 }] }
} } }))

let createRoot: typeof CreateRoot
let Editor: typeof import('./RegexPromptActivationEditor').default
const i18n = createInstance()
let root: Root | undefined
let host: HTMLDivElement
let latest: RegexPromptActivation | null

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { modals } }, interpolation: { escapeValue: false } })
  createRoot = (await import('react-dom/client')).createRoot
  Editor = (await import('./RegexPromptActivationEditor')).default
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  previewRequests.length = 0
  insertedTokens.length = 0
})

async function render(presetId: string | null, testInput = '', initialValue: string | string[] = 'combat') {
  const initial: RegexPromptActivation = { source: 'user_input', lifetime: 'latest', mappings: [
    { capture: '0', value: initialValue, block_ids: ['rules'], enabled: true },
  ] }
  latest = initial
  function Harness() {
    const [value, setValue] = useState<RegexPromptActivation | null>(initial)
    return <I18nextProvider i18n={i18n}><Editor presetId={presetId} value={value} onChange={(next) => {
      latest = next
      setValue(next)
    }}
      findRegex="combat" flags="gi" testInput={testInput} onExample={() => {}}
      chatId="chat" characterId="char" personaId="persona" connectionId="connection"
      onInsertFindInput={(token) => insertedTokens.push(token)} /></I18nextProvider>
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Harness />) })
}

test('unlinked scripts cannot configure preset activation', async () => {
  await render(null)
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true)
  expect(host.textContent).toContain('Link this script to a preset')
  expect(host.querySelector('fieldset')).toBeNull()
})

async function editEquals(text: string) {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="combat, fight, battle"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  return input
}

test('Equals accepts commas and newlines without dropping separators while typing', async () => {
  await render('preset', 'fight')
  const input = await editEquals('combat, ')
  expect(input.value).toBe('combat, ')
  expect(latest!.mappings[0].value).toBe('combat')
  await editEquals('combat, fight\nbattle')
  expect(input.value).toBe('combat, fight\nbattle')
  expect(latest!.mappings[0].value).toEqual(['combat', 'fight', 'battle'])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
  expect(previewRequests.at(-1).prompt_activation.mappings[0].value).toEqual(['combat', 'fight', 'battle'])
})

test('legacy comma-containing values remain quoted literals and malformed input cannot save stale values', async () => {
  await render('preset', '', 'hello, world')
  expect(host.querySelector('textarea')!.value).toBe('"hello, world"')
  const input = await editEquals('"hello, world", greetings')
  expect(latest!.mappings[0].value).toEqual(['hello, world', 'greetings'])
  await editEquals('"unfinished')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(latest!.mappings[0].value).toEqual([])
  await editEquals('')
  expect(input.getAttribute('aria-invalid')).toBe('false')
  expect(latest!.mappings[0].value).toEqual([])
})

test('saved value lists load into the Equals editor', async () => {
  await render('preset', '', ['combat', 'fight', 'battle'])
  expect(host.querySelector('textarea')!.value).toBe('combat, fight, battle')
  expect(latest!.mappings[0].value).toEqual(['combat', 'fight', 'battle'])
})

test('inserts explicit bounded references and previews with the current context', async () => {
  await render('preset', 'combat')
  const char = [...host.querySelectorAll('button')].find((button) => button.textContent === '{{char}}')!
  await act(async () => char.click())
  const key = host.querySelector<HTMLInputElement>('input[placeholder="desired_mode"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(key, 'desired_mode')
    key.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Append chat input')!.click())
  const select = [...host.querySelectorAll('select')].find((select) => select.textContent?.includes('Combat rules / mode'))!
  await act(async () => {
    select.value = '{{presetvar::rules::mode-id}}'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(insertedTokens).toEqual(['{{char}}', '{{getchatvar::desired_mode}}', '{{presetvar::rules::mode-id}}'])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
  expect(previewRequests.at(-1)).toMatchObject({ chat_id: 'chat', character_id: 'char', persona_id: 'persona', connection_id: 'connection' })
})

test('maps captures to stable block IDs with multi-block and category selection', async () => {
  await render('preset')
  expect(host.textContent).toContain('Linked preset: Adventure')
  const choices = [...host.querySelectorAll('fieldset label')]
  const format = choices.find((label) => label.textContent?.includes('Combat format'))!.querySelector('input')!
  await act(async () => format.click())
  expect(latest!.mappings[0].block_ids).toEqual(['rules', 'format'])
  const category = choices.find((label) => label.textContent?.includes('Scene instructions'))!.querySelector('input')!
  await act(async () => category.click())
  expect(latest!.mappings[0].block_ids).toEqual(['rules', 'format', 'category'])
  const capture = [...host.querySelectorAll('label')].find((label) => label.textContent === 'Capture')!.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(capture, 'mode')
    capture.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  expect(latest!.mappings[0].capture).toBe('mode')
})

test('source, lifetime, operation and preview use the editable mapping', async () => {
  await render('preset', '<state>combat</state>')
  const selects = ['ai_output', 'chat', 'false'].map((value) => host.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!.closest('select')!)
  await act(async () => {
    selects[0].value = 'ai_output'
    selects[0].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await act(async () => {
    selects[1].value = 'chat'
    selects[1].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await act(async () => {
    selects[2].value = 'false'
    selects[2].dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await Bun.sleep(350)
  })
  await act(async () => { await Bun.sleep(350) })
  expect(latest!.source).toBe('ai_output')
  expect(latest!.lifetime).toBe('chat')
  expect(latest!.mappings[0].enabled).toBe(false)
  expect(previewRequests.at(-1).prompt_activation).toEqual(latest)
  expect(host.textContent).toContain('“combat” → Disable: Combat rules')
})
