import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://lumiverse.example/sso-complete' })
const replace = mock((_target: string) => {})
const close = mock(() => {})
const publishSsoCompletion = mock(() => {})
const location = { search: '', origin: 'https://lumiverse.example', replace }
const originalGlobals = Object.fromEntries(
  ['window', 'document', 'HTMLElement', 'Element', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Reflect.get(globalThis, key)]),
)
Object.assign(globalThis, {
  window: new Proxy(dom.window, { get: (target, key) => key === 'location' ? location : key === 'close' ? close : Reflect.get(target, key) }),
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  IS_REACT_ACT_ENVIRONMENT: true,
})
mock.module('@/lib/ssoPopup', () => ({ publishSsoCompletion }))
const { default: SsoCompletePage } = await import('./SsoCompletePage')
const { createRoot } = await import('react-dom/client')
let testRoot: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  await act(async () => testRoot?.unmount())
  testRoot = null
  replace.mockClear()
  close.mockClear()
  publishSsoCompletion.mockClear()
})
afterAll(() => {
  dom.window.close()
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
  mock.restore()
})

async function render(query = '') {
  location.search = `?flow=login&provider=example&flowId=test-flow&mode=redirect${query}`
  testRoot = createRoot(document.getElementById('root')!)
  await act(async () => testRoot!.render(<SsoCompletePage />))
}

test('a same-window callback returns to the app without closing its PWA window', async () => {
  await render('&returnTo=%2Fchat%2Fone')

  expect(replace).toHaveBeenCalledWith('/chat/one')
  expect(close).not.toHaveBeenCalled()
  expect(publishSsoCompletion).not.toHaveBeenCalled()
})

test.each(['//evil.example', '/\\evil.example', '/\n/evil.example'])('a same-window callback refuses external return target %s', async target => {
  await render(`&returnTo=${encodeURIComponent(target)}`)
  expect(replace).toHaveBeenCalledWith('/')
})

test('provider errors remain visible with a way back to Lumiverse', async () => {
  await render('&error=Access%20denied')

  expect(document.body.textContent).toContain('Access denied')
  expect(replace).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  const button = document.querySelector('button')!
  expect(button.textContent).toBe('Return to Lumiverse')
  await act(async () => button.click())
  expect(replace).toHaveBeenCalledWith('/')
})
