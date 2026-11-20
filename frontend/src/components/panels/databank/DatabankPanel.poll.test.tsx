import { expect, mock, test } from 'bun:test'
import { act, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/components/shared/NumericInput', () => ({ default: () => null }))
mock.module('@/components/shared/ExpandedTextEditor', () => ({ ExpandableTextarea: () => null }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: () => null }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Checkbox: () => null, Switch: () => null } }))
const listeners = new Set<() => void>()
let state: any
function patch(values: any) { state = { ...state, ...values }; listeners.forEach(fn => fn()) }
const useStore = Object.assign((selector?: (value: any) => any) => {
  const value = useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn) }, () => state)
  return selector ? selector(value) : value
}, { getState: () => state })
mock.module('@/store', () => ({ useStore }))
const banks = ['A', 'B'].map(id => ({ id, name: id, scope: 'global', enabled: true, description: '', documentCount: 1 }))
const doc = (bankId: string, status = 'ready') => ({ id: `${bankId}-doc`, databankId: bankId, name: `${bankId} document`, fileSize: 20, status, totalChunks: 1 })
let resolveOldPoll!: (value: any) => void
const oldPoll = new Promise(r => { resolveOldPoll = r })
let holdPoll = false
mock.module('@/api/databank', () => ({ databankApi: {
  list: async () => ({ data: banks }),
  listDocuments: async (id: string) => id === 'A' && holdPoll ? oldPoll : { data: [doc(id, id === 'A' ? 'processing' : 'ready')] },
} }))
mock.module('@/api/settings', () => ({ settingsApi: { get: async () => ({ value: {} }) } }))
mock.module('@/api/characters', () => ({ charactersApi: {} }))
mock.module('@/api/chats', () => ({ chatsApi: {} }))
const { createRoot } = await import('react-dom/client')
const { default: DatabankPanel } = await import('./DatabankPanel')
test('poll response from A must not overwrite selected bank B', async () => {
  state = {
    databanks: banks, databankDocuments: [], selectedDatabankId: null, databankScopeFilter: 'global', characters: [],
    activeChatId: null, activeCharacterId: null,
    setDatabanks: (databanks: any) => patch({ databanks }),
    setSelectedDatabankId: (selectedDatabankId: any) => patch({ selectedDatabankId }),
    setDatabankDocuments: (databankDocuments: any) => patch({ databankDocuments }),
  }
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let poll: (() => Promise<void>) | null = null
  globalThis.setInterval = ((fn: any) => { poll = fn; return 123 }) as any
  globalThis.clearInterval = (() => {}) as any
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<DatabankPanel />))
    await act(async () => patch({ selectedDatabankId: 'A' }))
    expect(poll).not.toBeNull()
    holdPoll = true
    const inFlight = poll!()
    await act(async () => patch({ selectedDatabankId: 'B' }))
    expect(state.databankDocuments[0].databankId).toBe('B')
    await act(async () => { resolveOldPoll({ data: [doc('A')] }); await inFlight })
    expect(state.databankDocuments[0].databankId).toBe('B')
  } finally {
    act(() => root.unmount()); host.remove()
    globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval
  }
})
