import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import modals from '@/i18n/locales/en/modals.json'
import common from '@/i18n/locales/en/common.json'

const chats = [{ id: 'harbor', name: 'Harbor', message_count: 12, created_at: 1, updated_at: 2, last_message_preview: 'A ship arrives.' }]
const onSelect = mock(() => {})
const store = { closeModal: mock(() => {}), characters: [], modalProps: { characterId: 'character', characterName: 'Captain' }, activeChatId: null }
mock.module('@/hooks/useCharacterCatalog', () => ({ useCharacterCatalog: () => store.characters }))
mock.module('@/store', () => ({ useStore: (select: (state: typeof store) => unknown) => select(store) }))
mock.module('react-router', () => ({ useNavigate: () => () => {} }))
mock.module('@/api/client', () => ({ get: async () => chats }))
mock.module('@/api/chats', () => ({ chatsApi: { update: async () => {}, listGroupChats: async () => chats } }))
mock.module('@/lib/toast', () => ({ toast: {} }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: { children: ReactNode }) => createElement('div', {}, children) }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: () => null }))
for (const path of ['./ChatPickerModal.module.css', './ManageChatsModal.module.css']) {
  mock.module(path, () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
  Node: dom.window.Node, navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
const i18n = createInstance()
mock.module('@/i18n', () => ({ default: i18n }))
let createRoot: typeof import('react-dom/client').createRoot
let ChatPickerModal: typeof import('./ChatPickerModal').default
let ManageChatsModal: typeof import('./ManageChatsModal').default
let root: Root | null = null
let host: HTMLDivElement | null = null
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { modals, common } } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: ChatPickerModal } = await import('./ChatPickerModal'))
  ;({ default: ManageChatsModal } = await import('./ManageChatsModal'))
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  onSelect.mockClear()
})

async function render(view: 'picker' | 'manage') {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(I18nextProvider, { i18n }, view === 'picker'
      ? createElement(ChatPickerModal, { characterId: 'character', characterName: 'Captain', onSelect, onDismiss: () => {} })
      : createElement(ManageChatsModal)))
    await Promise.resolve()
  })
  return host
}

test('chat picker keeps opening, options, and previews separate', async () => {
  const host = await render('picker')
  const open = host.querySelector<HTMLButtonElement>('.openChatBtn')!
  const menu = host.querySelector<HTMLButtonElement>('[aria-label="More options: Harbor"]')!
  expect(open.textContent?.trim()).toBe('Harbor')
  expect(open.querySelector('button, input')).toBeNull()
  expect(host.querySelector('[role="button"]')).toBeNull()
  expect(host.querySelector('.previewText')?.textContent).toBe('A ship arrives.')
  expect(open.contains(host.querySelector('.previewText'))).toBe(false)
  act(() => open.click())
  expect(onSelect).toHaveBeenCalledWith('harbor')
  onSelect.mockClear()
  act(() => menu.click())
  expect(onSelect).not.toHaveBeenCalled()
  expect(menu.getAttribute('aria-expanded')).toBe('true')
})

test('Manage Chats identifies every per-chat action and names the rename input', async () => {
  const host = await render('manage')
  for (const action of ['Switch to this chat', 'Rename chat', 'Export chat', 'Delete chat']) {
    expect(host.querySelector(`[aria-label="${action}: Harbor"]`) !== null).toBe(true)
  }
  expect(host.querySelector('.cardPreview')?.textContent).toBe('A ship arrives.')
  expect(host.querySelector('.cardMeta')?.textContent).toContain('12 messages')
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Rename chat: Harbor"]')!.click())
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Rename chat: Harbor"]')!
  expect(document.activeElement === input).toBe(true)
})

test('Manage Chats announces bulk selection without changing its control name', async () => {
  const host = await render('manage')
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Bulk select"]')!.click())
  const select = host.querySelector<HTMLButtonElement>('[aria-label="Select Harbor"]')!
  expect(select.getAttribute('aria-pressed')).toBe('false')
  act(() => select.click())
  expect(select.getAttribute('aria-label')).toBe('Select Harbor')
  expect(select.getAttribute('aria-pressed')).toBe('true')
})
