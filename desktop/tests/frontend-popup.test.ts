import { expect, mock, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const script = await Bun.file(new URL('../src-tauri/src/frontend-popup.js', import.meta.url)).text()

function popup(invoke?: (...args: unknown[]) => unknown, childFrame = false, label = 'frontend-popup-1', webkit = false) {
  const browserClose = mock(() => {})
  const browserFetch = mock((..._args: unknown[]) => Promise.resolve('provider response'))
  const window = {
    close: browserClose,
    fetch: browserFetch,
    top: null as unknown,
    webkit: webkit ? { messageHandlers: { ipc: {} } } : undefined,
    __TAURI_INTERNALS__: invoke ? { invoke, metadata: { currentWindow: { label } } } : undefined,
  }
  window.top = childFrame ? {} : window
  runInNewContext(script, { window, Promise, URL })
  return { window, browserClose, browserFetch }
}

test('an extension callback closes its own native popup without knowing Tauri', async () => {
  const invoke = mock(() => Promise.resolve())
  const { window, browserClose } = popup(invoke)
  window.close()
  await Promise.resolve()
  expect(invoke).toHaveBeenCalledWith('close_current_sso_popup')
  expect(browserClose).not.toHaveBeenCalled()
})

test('a failed native close falls back to the browser close handler', async () => {
  const { window, browserClose } = popup(() => Promise.reject(new Error('IPC unavailable')))
  window.close()
  await Promise.resolve()
  expect(browserClose).toHaveBeenCalledTimes(1)
})

test('a synchronous IPC failure also falls back to browser close', () => {
  const { window, browserClose } = popup(() => { throw new Error('IPC unavailable') })
  window.close()
  expect(browserClose).toHaveBeenCalledTimes(1)
})

test('an inherited script leaves embedded frames and ordinary browser close intact', () => {
  const invoke = mock(() => Promise.resolve())
  const frame = popup(invoke, true)
  frame.window.close()
  expect(invoke).not.toHaveBeenCalled()
  expect(frame.browserClose).toHaveBeenCalledTimes(1)
  const browser = popup()
  browser.window.close()
  expect(browser.browserClose).toHaveBeenCalledTimes(1)
})

test('an inherited popup script never changes the main frontend close handler', () => {
  const invoke = mock(() => Promise.resolve())
  const { window, browserClose } = popup(invoke, false, 'frontend')
  expect(window.close).toBe(browserClose)
})

test('macOS popups reject inherited IPC fetches so Tauri uses their own message handler', async () => {
  const { window, browserFetch, browserClose } = popup(() => Promise.resolve(), false, 'frontend-popup-2', true)
  expect(window.close).toBe(browserClose)
  for (const input of ['ipc://localhost/close_current_sso_popup', new URL('ipc://localhost/close_current_sso_popup'), new Request('ipc://localhost/close_current_sso_popup')]) {
    await expect(window.fetch(input)).rejects.toThrow('per-window IPC')
  }
  expect(browserFetch).not.toHaveBeenCalled()
})

test('provider requests and non-WebKit IPC keep their original fetch transport', async () => {
  const mac = popup(() => Promise.resolve(), false, 'frontend-popup-2', true)
  const options = { method: 'POST', body: 'provider request' }
  await expect(mac.window.fetch('https://provider.example/token', options)).resolves.toBe('provider response')
  expect(mac.browserFetch).toHaveBeenCalledWith('https://provider.example/token', options)

  const other = popup(() => Promise.resolve())
  expect(other.window.fetch).toBe(other.browserFetch)
})
