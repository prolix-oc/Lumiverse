import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const copy = mock(async (_code: string) => {})
const t = (key: string) => key
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))
mock.module('@/store', () => ({ useStore: (select: (state: unknown) => unknown) => select({ user: { name: 'Owner' } }) }))
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: copy }))
mock.module('@/lib/settings-tab-registry', () => ({ sectionAnchorId: () => 'illarin' }))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
}))
const { default: IllarinSettings } = await import('./IllarinSettings')
let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previous: Record<string, unknown>
let authorizationUrl: string
let linked: boolean
let failCopy: boolean
const open = mock(() => null)

beforeEach(() => {
  authorizationUrl = 'https://illarin.com/authorize?request=example'
  linked = false
  failCopy = false
  copy.mockClear()
  copy.mockImplementation(async () => { if (failCopy) throw new Error('Clipboard unavailable') })
  open.mockClear()
  dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' })
  previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Reflect.get(globalThis, key)]))
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string) => Response.json(url.endsWith('/status') ? { linked } : {
      user_code: 'ABCD-EFGH', authorize_url: authorizationUrl, verification_url: authorizationUrl,
    }),
  })
  dom.window.open = open
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  dom.window.close()
  for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
})
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent === label)
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}
async function start(label = 'illarin.link') {
  await act(async () => { root.render(<IllarinSettings />) })
  await click(label)
}

test.each(['browser', 'device', 'remote'] as const)('%s linking lets the user copy before opening the authorization page', async (flow) => {
  if (flow === 'remote') dom.reconfigure({ url: 'https://lumiverse.example/' })
  await start(flow === 'device' ? 'illarin.deviceFallback' : 'illarin.link')
  const code = host.querySelector('input[readonly]') as HTMLInputElement
  expect(code.value).toBe('ABCD-EFGH')
  expect(open).not.toHaveBeenCalled()
  await click('common:actions.copy')
  expect(copy).toHaveBeenCalledWith('ABCD-EFGH')
  expect(host.textContent).toContain('modals:shared.copied')
  expect(open).not.toHaveBeenCalled()
  const link = host.querySelector('a[target=_blank]') as HTMLAnchorElement
  expect(link.href).toBe(authorizationUrl)
  expect(link.rel).toBe('noopener noreferrer')
})

test('failed clipboard access leaves a selectable code and a manual link', async () => {
  failCopy = true
  await start()
  await click('common:actions.copy')
  expect(host.textContent).toContain('Clipboard unavailable')
  expect((host.querySelector('input[readonly]') as HTMLInputElement).value).toBe('ABCD-EFGH')
  expect(host.querySelector('a[target=_blank]')).not.toBeNull()
  expect(open).not.toHaveBeenCalled()
})

test.each(['javascript:alert(1)', 'http://illarin.com/authorize'])('rejects an unsafe authorization URL: %s', async (url) => {
  authorizationUrl = url
  await start()
  expect(host.querySelector('a[target=_blank]')).toBeNull()
  expect(host.querySelector('input[readonly]')).toBeNull()
  expect(host.textContent).toContain('illarin.errLinkFailed')
  expect(open).not.toHaveBeenCalled()
})
