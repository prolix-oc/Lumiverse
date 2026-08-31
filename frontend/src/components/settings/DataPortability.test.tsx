import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { JSDOM } from 'jsdom'

const storeState = {
  user: { id: 'owner-user' },
  userDataJob: null,
  userDataJobLoading: false,
  userDataJobAction: null,
  userDataJobError: null,
  setUserDataJob: () => undefined,
  clearUserDataJob: () => undefined,
  startUserDataImport: async () => undefined,
  refreshUserDataJob: async () => undefined,
  reconnectUserDataJob: async () => undefined,
  submitUserDataTicket: async () => undefined,
  skipUserDataTicket: async () => undefined,
  cancelUserDataImport: async () => undefined,
}

const useStore = Object.assign(
  (selector: (value: typeof storeState) => unknown) => selector(storeState),
  { getState: () => storeState },
)
const prepareSecretsExport = mock(async (_includeVectors: boolean) => {
  throw new Error('prepare rejected')
})

mock.module('@/store', () => ({ useStore }))
mock.module('@/api/user-data', () => ({
  userDataApi: {
    exportUrl: () => '/api/v1/user-data/export',
    prepareSecretsExport,
  },
}))
mock.module('@/ws/client', () => ({ wsClient: { on: () => () => undefined } }))
mock.module('@/ws/events', () => ({
  EventType: {
    USER_EXPORT_PROGRESS: 'user_export_progress',
    USER_IMPORT_PROGRESS: 'user_import_progress',
    USER_IMPORT_COMPLETE: 'user_import_complete',
    USER_IMPORT_FAILED: 'user_import_failed',
  },
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  }),
}))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled }: {
    children?: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => createElement('button', { type: 'button', onClick, disabled }, children),
}))
mock.module('lucide-react', () => ({
  Download: () => createElement('span'),
  Upload: () => createElement('span'),
  X: () => createElement('span'),
  KeyRound: () => createElement('span'),
  ShieldAlert: () => createElement('span'),
  RefreshCw: () => createElement('span'),
}))
mock.module('./DataPortability.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLAnchorElement: dom.window.HTMLAnchorElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Bun must install the component's module mocks before loading this known module.
const { default: DataPortability } = await import('./DataPortability')

describe('DataPortability secret export preparation', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    act(() => { root?.unmount() })
    host?.remove()
    root = null
    host = null
    prepareSecretsExport.mockClear()
  })

  test('shows the dedicated prepare failure instead of an import-start reason', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(DataPortability))
      await Promise.resolve()
    })

    const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes.length).toBe(2)
    await act(async () => {
      checkboxes[1].click()
      await Promise.resolve()
    })
    const download = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('dataPortability.downloadArchive'),
    )
    expect(download).toBeDefined()

    await act(async () => {
      download?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(prepareSecretsExport).toHaveBeenCalledWith(true)
    expect(host.textContent).toContain('dataPortability.exportPrepareFailed')
    expect(host.textContent).not.toContain('dataPortability.failureReasons.import_start_failed')
    expect(host.textContent).not.toContain('dataPortability.exportSecretsWarn')
  })
})
