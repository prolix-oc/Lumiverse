import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import i18n from 'i18next'
import type { DesktopKeybindingsSnapshot } from '../src/lib/desktop-keybindings'
import type { ExtensionCommandState } from '../src/store/slices/spindle-placement'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/chat/current', pretendToBeVisual: true })
const globals = new Map(['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
;(window as any).__TAURI_INTERNALS__ = {}
const state = { user: { id: 'alice', role: 'user' }, extensionCommands: [] as ExtensionCommandState[], extensions: [] as Array<{ id: string; enabled: boolean }>, settingsTabs: [], isStreaming: false, messages: [{}], activeModal: null }
const run = mock(async (_navigate: unknown, _trigger?: unknown) => {})
const listeners = new Map<string, Set<(event: { payload: any }) => void>>()
const calls: Array<{ command: string; args: any }> = []
const chord = { code: 'KeyP', ctrl: true, alt: false, shift: true, meta: false }
let saved: DesktopKeybindingsSnapshot
let acceptGlobal = true
let publishBarrier: Promise<void> | undefined
let snapshotBarrier: Promise<void> | undefined
mock.module('@/store', () => ({ useStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }))
mock.module('react-router', () => ({ useLocation: () => ({ pathname: '/chat/current' }), useNavigate: () => () => {} }))
mock.module('@/lib/commands', () => ({ buildCommands: () => [{ id: 'analyze', label: 'Analyze', scope: 'chat-idle', run }] }))
mock.module('@/lib/drawer-tab-registry', () => ({ extensionCommandsToCommands: (entries: ExtensionCommandState[]) => entries.flatMap(entry => entry.commands.map(command => ({ ...command, id: `ext-cmd-${entry.extensionId}-${command.id}`, run }))) }))
mock.module('@/lib/desktop-floating-widget', () => ({ isDesktopFloatingWidgetWindow: () => false }))
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, handler: (event: any) => void) => {
  const handlers = listeners.get(name) ?? new Set(); listeners.set(name, handlers); handlers.add(handler)
  return () => { handlers.delete(handler) }
} }))
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args })
  if (command === 'desktop_keybindings_publish') {
    await publishBarrier
    return [{ id: 'focused', chord, scope: 'focused' }, { id: 'global', chord: { ...chord, code: 'KeyG' }, scope: 'global' }]
  }
  if (command === 'desktop_keybindings_trigger') emit('focused', 'focused')
  if (command === 'desktop_keybindings_frontend_get') {
    const next = structuredClone(saved)
    await snapshotBarrier
    return next
  }
  if (command === 'desktop_keybindings_global_permission') {
    if (args.enabled && !acceptGlobal) return false
    saved.globalEnabled = args.enabled
    if (!args.enabled) saved.bindings = saved.bindings.map(binding => ({ ...binding, scope: 'focused' }))
    return args.enabled
  }
  if (command === 'desktop_keybindings_frontend_save') saved.bindings = args.commandId
    ? [...saved.bindings.filter(binding => binding.action !== args.commandId), ...structuredClone(args.bindings)] : structuredClone(args.bindings)
} }))
let createRoot: typeof import('react-dom/client').createRoot
let useBindings: typeof import('../src/hooks/useDesktopKeybindings').useDesktopKeybindings
let root: Root | null = null
let host: HTMLElement | null = null
let Settings: typeof import('../src/components/settings/DesktopKeybindingsSettings').default
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { shared: {} } } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useDesktopKeybindings: useBindings } = await import('../src/hooks/useDesktopKeybindings'))
  ;({ default: Settings } = await import('../src/components/settings/DesktopKeybindingsSettings'))
})
afterAll(() => {
  mock.restore()
  dom.window.close()
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
afterEach(async () => {
  await act(async () => { root?.unmount(); await Bun.sleep(0) }); host?.remove(); root = null; host = null
  listeners.clear(); calls.length = 0; run.mockClear()
  state.user.id = 'alice'; state.isStreaming = false
  state.extensionCommands = []; state.extensions = []; state.settingsTabs = []; publishBarrier = undefined; snapshotBarrier = undefined
  acceptGlobal = true
})
function Component({ revision = 0 }: { revision?: number }) { void revision; useBindings(); return null }
async function render() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Component)); await Bun.sleep(0) })
}
function emit(bindingId: string, scope: string, accountId = 'alice') {
  for (const handler of listeners.get('desktop-keybinding-trigger') ?? []) handler({ payload: { bindingId, scope, accountId, commandId: 'analyze' } })
}
function press(code: string, repeat = false) {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, ctrlKey: true, shiftKey: true, repeat, bubbles: true, cancelable: true }))
}
test('focused input fires once, global DOM input does not duplicate the native trigger, and repeat is ignored', async () => {
  await render()
  await act(async () => { press('KeyP'); press('KeyP', true); press('KeyG') })
  expect(calls.filter(call => call.command === 'desktop_keybindings_trigger')).toHaveLength(1)
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0][1]).toEqual({ type: 'keybind', bindingId: 'focused', scope: 'focused' })
  const editor = document.createElement('div'); editor.setAttribute('data-desktop-keybinding-editor', '')
  const input = document.createElement('input'); editor.append(input); document.body.append(editor)
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }))
  expect(calls.filter(call => call.command === 'desktop_keybindings_trigger')).toHaveLength(1)
  editor.remove()
  await act(async () => emit('global', 'global'))
  expect(run).toHaveBeenCalledTimes(2)
})
test('late events from another account and commands outside their current scope cannot run', async () => {
  await render()
  await act(async () => emit('global', 'global', 'bob'))
  state.user.id = 'bob'
  await act(async () => emit('global', 'global'))
  state.user.id = 'alice'; state.isStreaming = true
  await act(async () => emit('global', 'global'))
  expect(run).not.toHaveBeenCalled()
})

test('extension catalog updates stay signed in, retain stable action IDs, and publish in order', async () => {
  state.extensions = [{ id: 'installed', enabled: true }]
  state.extensionCommands = [{ extensionId: 'installed', extensionName: 'Capture', commands: [{ id: 'analyze', label: 'Analyze Screen', description: '' }] }]
  let release!: () => void
  publishBarrier = new Promise(resolve => { release = resolve })
  try {
    await render()
    state.settingsTabs = []
    await act(async () => { root!.render(createElement(Component, { revision: 1 })); await Bun.sleep(0) })
    state.extensionCommands = [{ ...state.extensionCommands[0], commands: [{ id: 'analyze', label: 'Analyze Display', description: '' }] }]
    await act(async () => { root!.render(createElement(Component, { revision: 2 })); await Bun.sleep(0) })
    expect(calls.filter(call => call.command === 'desktop_keybindings_publish')).toHaveLength(1)
  } finally { release(); publishBarrier = undefined }
  await act(async () => { await Bun.sleep(0) })
  const published = calls.filter(call => call.command === 'desktop_keybindings_publish')
  expect(published).toHaveLength(2)
  expect(published.every(call => call.args.accountId === 'alice')).toBe(true)
  expect(published[0].args.commands).toContainEqual({ id: 'ext-cmd-installed-analyze', label: 'Analyze Screen' })
  expect(published[1].args.commands).toContainEqual({ id: 'ext-cmd-installed-analyze', label: 'Analyze Display' })
  await act(async () => { root!.unmount(); root = null; await Bun.sleep(0) })
  expect(calls.at(-1)).toEqual({ command: 'desktop_keybindings_publish', args: { accountId: '', commands: [] } })
})

async function renderSettings(extensionCommand?: { extensionId: string; commandId: string }) {
  saved = { bindings: [], commands: [{ id: 'ext-cmd-installed-analyze', label: 'Analyze Screen' }], origin: 'https://instance', accountId: 'alice', errors: {}, globalAvailable: true, globalEnabled: false }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Settings, { extensionCommand })); await Bun.sleep(0) })
}
const button = (text: string) => [...host!.querySelectorAll('button')].find(button => button.textContent === text)!
const select = (label: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
async function changeSelect(label: string, value: string) {
  await act(async () => select(label).click())
  const text = value === 'global' ? 'Global' : value === 'focused' ? 'In Lumiverse' : value
  await act(async () => host!.querySelector<HTMLButtonElement>(`[role="option"][aria-label="${text}"]`)!.click())
}
async function record() {
  const field = host!.querySelector<HTMLButtonElement>('button[aria-label="Shortcut 1"]')!
  await act(async () => field.click())
  expect(document.activeElement).toBe(field)
  expect(calls.filter(call => call.command === 'desktop_keybindings_editing').at(-1)?.args).toEqual({ editing: true })
  await act(async () => { document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyP', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })) })
}
test('frontend settings configure focused bindings without approval and reuse one global opt-in', async () => {
  await renderSettings()
  expect(calls.some(call => call.command === 'desktop_keybindings_global_permission' || call.command === 'desktop_keybindings_frontend_save')).toBe(false)
  await act(async () => button('Add Binding').click())
  await record()
  expect(select('Scope 1').textContent).toContain('In Lumiverse')
  await act(async () => select('Scope 1').click())
  expect(host!.querySelector<HTMLButtonElement>('[role="option"][aria-label="Global"]')!.disabled).toBe(true)
  await act(async () => select('Scope 1').click())
  await act(async () => button('Save Bindings').click())
  expect(saved.bindings[0].scope).toBe('focused')
  expect(calls.filter(call => call.command === 'desktop_keybindings_global_permission')).toHaveLength(0)
  await act(async () => host!.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  await changeSelect('Scope 1', 'global')
  await act(async () => button('Save Bindings').click())
  expect(saved.bindings[0].scope).toBe('global')
  await record()
  await act(async () => button('Save Bindings').click())
  expect(calls.filter(call => call.command === 'desktop_keybindings_global_permission')).toHaveLength(1)
  await act(async () => host!.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  expect(saved.globalEnabled).toBe(false)
  expect(saved.bindings[0].scope).toBe('focused')
})
test('inline extension editor stays in its panel and saves only its own command', async () => {
  await renderSettings({ extensionId: 'installed', commandId: 'analyze' })
  expect(host!.textContent).toContain('Analyze Screen')
  expect(select('Action 1')).toBeNull()
  await act(async () => button('Add Binding').click())
  await act(async () => select('Action 1').click())
  expect(host!.querySelectorAll('[role="option"]')).toHaveLength(1)
  await act(async () => select('Action 1').click())
  await record()
  await act(async () => button('Save Bindings').click())
  const save = calls.find(call => call.command === 'desktop_keybindings_frontend_save')!
  expect(save.args.commandId).toBe('ext-cmd-installed-analyze')
  expect(save.args.bindings[0].action).toBe('ext-cmd-installed-analyze')
  expect(save.args.bindings[0].origin).toBe('https://instance')
  expect(save.args.bindings[0].accountId).toBe('alice')
  acceptGlobal = false
  await act(async () => button('Enable global key bindings').click())
  await act(async () => select('Scope 1').click())
  expect(host!.querySelector<HTMLButtonElement>('[role="option"][aria-label="Global"]')!.disabled).toBe(true)
  expect(calls.some(call => call.command === 'desktop_keybindings_show')).toBe(false)
})

test('settings record every standalone extended function key and save it as a global binding', async () => {
  await renderSettings()
  await act(async () => host!.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  await act(async () => button('Add Binding').click())
  await changeSelect('Scope 1', 'global')
  for (let number = 13; number <= 24; number++) {
    const code = `F${number}`
    const field = select('Shortcut 1')
    await act(async () => {
      field.focus()
      field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: code, code, bubbles: true, cancelable: true }))
    })
    expect(field.textContent).toBe(code)
    expect(button('Save Bindings').disabled).toBe(false)
    await act(async () => button('Save Bindings').click())
    expect(saved.bindings[0]).toMatchObject({ scope: 'global', chord: { code, ctrl: false, alt: false, shift: false, meta: false } })
    expect(host!.textContent).toContain('Key bindings saved.')
  }
})

test('the manual key selector accepts standalone F13 and F24', async () => {
  await renderSettings({ extensionId: 'installed', commandId: 'analyze' })
  await act(async () => button('Add Binding').click())
  for (const code of ['F13', 'F24']) {
    await changeSelect('Key 1', code)
    expect(button('Save Bindings').disabled).toBe(false)
    await act(async () => button('Save Bindings').click())
    expect(saved.bindings[0]).toMatchObject({ action: 'ext-cmd-installed-analyze', chord: { code, ctrl: false, alt: false, shift: false, meta: false } })
  }
})

test('a late catalog response during extension reload cannot replace the restored action name', async () => {
  await renderSettings({ extensionId: 'installed', commandId: 'analyze' })
  await act(async () => button('Add Binding').click())
  await record()
  await act(async () => button('Save Bindings').click())
  const binding = structuredClone(saved.bindings[0])
  let release!: () => void
  snapshotBarrier = new Promise(resolve => { release = resolve })
  const refresh = async () => act(async () => {
    for (const handler of listeners.get('desktop-keybindings-catalog') ?? []) handler({ payload: {} })
    await Bun.sleep(0)
  })
  try {
    saved.commands = []
    await refresh()
    snapshotBarrier = undefined
    saved.commands = [{ id: binding.action, label: 'Analyze Display' }]
    await refresh()
    expect(host!.textContent).toContain('Analyze Display')
  } finally { release(); snapshotBarrier = undefined }
  await act(async () => { await Bun.sleep(0) })
  expect(host!.textContent).toContain('Analyze Display')
  expect(host!.textContent).not.toContain('Currently unavailable')
  expect(saved.bindings).toEqual([binding])
  expect(select('Action 1').textContent).toContain('Analyze Display')
})

test('shortcut recording preserves keyboard navigation and unsaved edits can be discarded', async () => {
  await renderSettings()
  await act(async () => button('Add Binding').click())
  expect(button('Save Bindings').disabled).toBe(true)
  const field = select('Shortcut 1')
  const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true })
  await act(async () => { field.focus(); field.dispatchEvent(tab) })
  expect(tab.defaultPrevented).toBe(false)
  await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true, cancelable: true })))
  expect(button('Save Bindings').disabled).toBe(true)
  expect(host!.textContent).toContain('Include Control')
  await record()
  expect(field.querySelectorAll('kbd').length).toBe(3)
  expect(button('Save Bindings').disabled).toBe(false)
  await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })))
  expect(document.activeElement).not.toBe(field)
  await act(async () => button('Discard changes').click())
  expect(select('Action 1')).toBeNull()
  expect(host!.textContent).toContain('No shortcuts yet')
  expect(calls.some(call => call.command === 'desktop_keybindings_frontend_save')).toBe(false)
})
