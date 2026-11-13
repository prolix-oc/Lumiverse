import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { create } from 'zustand'
import type { McpServerProfile, CreateMcpServerInput, UpdateMcpServerInput } from '@/api/mcp-servers'
import { createMcpServersSlice } from '@/store/slices/mcp-servers'
import type { McpServersSlice } from '@/types/store'
import settings from '@/i18n/locales/en/settings.json'
import common from '@/i18n/locales/en/common.json'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globals = {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
}
const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Reflect.get(globalThis, key)]))
Object.assign(globalThis, globals)
const { createRoot } = await import('react-dom/client')
const { ApiError } = await import('@/api/client')
const useMcpStore = create<McpServersSlice>()(createMcpServersSlice)
mock.module('@/store', () => ({ useStore: useMcpStore }))
mock.module('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string) => key.split('.').reduce((value, part) => value?.[part], namespace === 'settings' ? settings : common) ?? key,
  }),
}))

function profile(input: Partial<McpServerProfile> = {}): McpServerProfile {
  return {
    id: 'server-1', name: 'Remote server', transport_type: 'streamable_http',
    url: 'https://example.test/mcp', command: '', args: [], env: {}, has_headers: false,
    is_enabled: true, auto_connect: true, metadata: {}, last_connected_at: null,
    last_error: null, created_at: 1, updated_at: 1, ...input,
  }
}

let storedServers: McpServerProfile[]
const list = mock(async () => ({ data: storedServers, total: storedServers.length }))
const createServer = mock(async (input: CreateMcpServerInput) => profile(input))
const updateServer = mock(async (id: string, input: UpdateMcpServerInput) => profile({ ...input, id }))
mock.module('@/api/mcp-servers', () => ({
  mcpServersApi: { list, allStatus: async () => ({ servers: [] }), create: createServer, update: updateServer },
}))
const { default: McpServerSettings } = await import('./McpServerSettings')

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
beforeEach(() => {
  storedServers = []
  useMcpStore.setState({ mcpServers: [], mcpServerStatuses: {} })
  createServer.mockReset().mockImplementation(async input => profile(input))
  updateServer.mockReset().mockImplementation(async (id, input) => profile({ ...input, id }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
afterAll(() => {
  dom.window.close()
  for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
})

async function mount() {
  await act(async () => root.render(<McpServerSettings />))
}
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find(node => node.textContent === text)
  expect(result).toBeDefined()
  return result!
}
function input(placeholder: string) {
  const result = [...host.querySelectorAll('input')].find(node => node.placeholder === placeholder)
  expect(result).toBeDefined()
  return result!
}
async function click(node: HTMLElement) {
  await act(async () => node.click())
}
async function setText(placeholder: string, value: string) {
  const node = input(placeholder)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function setStdio(command = 'npx', args = '-y, @modelcontextprotocol/server-filesystem, /tmp') {
  const select = host.querySelector('select')!
  await act(async () => {
    select.value = 'stdio'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await setText(settings.mcp.commandPlaceholder, command)
  await setText(settings.mcp.argsPlaceholder, args)
}
async function startCreate() {
  await mount()
  await click(button(settings.mcp.addServer))
  await setText(settings.mcp.namePlaceholder, 'Local server')
  await setStdio()
}

test('failed creates show the backend error, preserve values, and can be corrected and saved', async () => {
  const reason = 'MCP stdio command "npx" is not in the allowlist. Set MCP_STDIO_ALLOWED_COMMANDS to extend it.'
  createServer.mockRejectedValueOnce(new ApiError(400, 'Bad Request', { error: reason }))
  await startCreate()
  await setText(settings.mcp.varName, 'TOKEN')
  await setText(settings.mcp.headerValue, 'secret-value')
  await click(button(common.actions.save))

  expect(host.querySelector('[role="alert"]')?.textContent).toBe(reason)
  expect(input(settings.mcp.namePlaceholder).value).toBe('Local server')
  expect(input(settings.mcp.commandPlaceholder).value).toBe('npx')
  expect(input(settings.mcp.headerValue).value).toBe('secret-value')
  expect(useMcpStore.getState().mcpServers).toEqual([])
  expect(button(common.actions.save).disabled).toBe(false)
  expect(host.textContent).toContain(settings.mcp.stdioPolicyHint)

  await setStdio('node', './server.js')
  await click(button(common.actions.save))
  expect(createServer).toHaveBeenLastCalledWith(expect.objectContaining({
    name: 'Local server', transport_type: 'stdio', command: 'node', args: ['./server.js'], env: { TOKEN: 'secret-value' },
  }))
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('input')).toBeNull()
  expect(useMcpStore.getState().mcpServers[0].command).toBe('node')
})

test('rejected HTTP-to-stdio edits stay open until the corrected update succeeds', async () => {
  storedServers = [profile()]
  const reason = 'MCP stdio package "unapproved" is not in MCP_STDIO_ALLOWED_PACKAGES'
  updateServer.mockRejectedValueOnce(new ApiError(400, 'Bad Request', { error: reason }))
  await mount()
  await click(host.querySelector<HTMLButtonElement>('button[title="Edit"]')!)
  await setStdio()
  await click(button(common.actions.save))

  expect(host.querySelector('[role="alert"]')?.textContent).toBe(reason)
  expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('stdio')
  expect(input(settings.mcp.commandPlaceholder).value).toBe('npx')
  expect(useMcpStore.getState().mcpServers[0].transport_type).toBe('streamable_http')

  await setStdio('node', './server.js')
  await click(button(common.actions.save))
  expect(updateServer).toHaveBeenLastCalledWith('server-1', expect.objectContaining({
    transport_type: 'stdio', command: 'node', args: ['./server.js'],
  }))
  expect(host.querySelector('select')).toBeNull()
  expect(useMcpStore.getState().mcpServers[0].transport_type).toBe('stdio')
})

test.each(['create', 'update'] as const)('pending %s keeps the form open and prevents duplicate saves', async mode => {
  let finish!: (server: McpServerProfile) => void
  const pending = new Promise<McpServerProfile>(resolve => { finish = resolve })
  if (mode === 'create') {
    createServer.mockImplementationOnce(() => pending)
    await startCreate()
  } else {
    storedServers = [profile()]
    updateServer.mockImplementationOnce(() => pending)
    await mount()
    await click(host.querySelector<HTMLButtonElement>('button[title="Edit"]')!)
    await setStdio('node', './server.js')
  }
  const save = button(common.actions.save)
  await act(async () => { save.click(); save.click() })

  const request = mode === 'create' ? createServer : updateServer
  expect(request).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(save.disabled).toBe(true)
  expect(button(common.actions.cancel).disabled).toBe(true)
  expect(input(settings.mcp.commandPlaceholder).disabled).toBe(true)
  await click(save)
  expect(request).toHaveBeenCalledTimes(1)

  await act(async () => finish(profile({ name: 'Local server', transport_type: 'stdio', command: 'node', args: ['./server.js'] })))
  expect(host.querySelector('select')).toBeNull()
  expect(useMcpStore.getState().mcpServers[0].command).toBe('node')
})

test.each([
  [new Error('Network unavailable'), 'Network unavailable'],
  [null, settings.mcp.saveFailed],
  [new ApiError(500, 'Internal Server Error', { error: { unexpected: true } }), '500 Internal Server Error'],
])('failed saves handle network errors and missing or non-text error bodies', async (error, message) => {
  createServer.mockRejectedValueOnce(error)
  await startCreate()
  await click(button(common.actions.save))
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message)
  expect(input(settings.mcp.commandPlaceholder).value).toBe('npx')
})
