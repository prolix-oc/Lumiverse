import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import common from '../../i18n/locales/en/common.json'
import panels from '../../i18n/locales/en/panels.json'
import shared from '../../i18n/locales/en/shared.json'
import type { RegexScript } from '@/types/regex'

let createRoot: typeof CreateRoot
let RegexPanel: () => ReactNode
let resetRegexEvidenceForTests: () => void

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

if (!domWindow.PointerEvent) {
  class TestPointerEvent extends domWindow.MouseEvent {}
  Object.assign(domWindow, { PointerEvent: TestPointerEvent })
  Object.assign(globalThis, { PointerEvent: TestPointerEvent })
}

if (!globalThis.ResizeObserver) {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
}

if (!domWindow.HTMLElement.prototype.scrollIntoView) {
  domWindow.HTMLElement.prototype.scrollIntoView = () => {}
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const evidenceReports: Array<{ id: string; payload: Record<string, unknown> }> = []
let reportEvidenceImpl: (id: string, payload: Record<string, unknown>) => Promise<unknown> = async () => ({})
const successToasts: string[] = []
const errorToasts: string[] = []
let storedRegexFolders: string[] = []
const putSetting = jest.fn(async (key: string, value: unknown) => {
  if (key === 'regexScriptFolders' && Array.isArray(value)) {
    storedRegexFolders = value as string[]
  }
})

mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: (id: string, payload: Record<string, unknown>) => {
      evidenceReports.push({ id, payload })
      return reportEvidenceImpl(id, payload)
    },
    list: async () => ({ data: [], total: 0, limit: 1000, offset: 0 }),
    reportPerformance: async () => ({}),
  },
}))
mock.module('@/api/settings', () => ({
  settingsApi: {
    get: async (key: string) => ({ value: key === 'regexScriptFolders' ? storedRegexFolders : [] }),
    put: putSetting,
  },
}))
mock.module('@/lib/toast', () => ({
  toast: {
    success: (message: string) => successToasts.push(message),
    error: (message: string) => errorToasts.push(message),
    warning: () => {},
    info: () => {},
  },
}))

const loadRegexScripts = jest.fn(async () => {})
const updateRegexScript = jest.fn(async (_id: string, _updates: Partial<RegexScript>) => {})

let storeState: Record<string, unknown> = {}

function baseStoreState(scripts: RegexScript[]): Record<string, unknown> {
  return {
    regexScripts: scripts,
    loadRegexScripts,
    addRegexScript: jest.fn(async () => scripts[0]),
    updateRegexScript,
    removeRegexScript: jest.fn(async () => {}),
    bulkRemoveRegexScripts: jest.fn(async () => 0),
    toggleRegexScript: jest.fn(async () => {}),
    toggleSelectedRegexScripts: jest.fn(async () => ({ changedIds: [], skippedIds: [] })),
    toggleRegexFolder: jest.fn(async () => ({ changedIds: [], skippedIds: [] })),
    reorderRegexScripts: jest.fn(async () => {}),
    openModal: jest.fn(),
    activeCharacterId: null,
    activeChatId: null,
    activeLoomPresetId: null,
    presets: {},
  }
}

mock.module('@/store', () => ({
  useStore: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => (selector ? selector(storeState) : storeState),
    {
      getState: () => storeState,
      setState: (patch: Record<string, unknown>) => Object.assign(storeState, patch),
      subscribe: () => () => {},
    },
  ),
}))

const englishI18n = createInstance()
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

// The app-level i18n module eagerly resolves locale bundles through
// `import.meta.glob`, which Bun's test runtime does not implement. Delegate the
// imperative `i18n.t` calls in the panel to the instance this test controls.
mock.module('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => englishI18n.t(key, options),
    language: 'en',
    on: () => {},
    off: () => {},
  },
  initI18n: async () => {},
  ensureLanguageLoaded: async () => {},
  changeUiLanguage: async () => {},
  UI_LANGUAGE_STORAGE_KEY: 'ui-language',
}))

function script(id: string, overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id, user_id: 'user', name: id, script_id: id, find_regex: 'x', replace_string: 'y',
    actions: [], flags: 'g', placement: ['ai_output'], scope: 'global', scope_id: null,
    target: ['display'], min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false,
    substitute_macros: 'none', disabled: false, sort_order: 0, description: '', folder: '', metadata: {},
    created_at: 1, updated_at: 1, ...overrides,
  }
}

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })

  await act(async () => {
    root.render(<I18nextProvider i18n={englishI18n}>{node}</I18nextProvider>)
    await Promise.resolve()
  })

  return host
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function byAriaLabel(host: HTMLElement, label: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}

function folderHeader(host: HTMLElement, name: string): HTMLElement {
  const header = [...host.querySelectorAll<HTMLElement>('[role="button"][aria-expanded]')]
    .find((element) => element.textContent?.startsWith(name))
  expect(header).toBeDefined()
  return header!
}

async function openFolderMenu(host: HTMLElement, name: string) {
  await act(async () => {
    folderHeader(host, name).dispatchEvent(new domWindow.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 80, clientY: 100,
    }))
  })
}

function menuButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.textContent?.trim() === label)
  expect(button).toBeDefined()
  return button!
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
  })
}

async function rerender(host: HTMLElement) {
  const { root } = mountedRoots.find((mounted) => mounted.host === host)!
  await act(async () => {
    root.render(<I18nextProvider i18n={englishI18n}><RegexPanel /></I18nextProvider>)
  })
}

const QUARANTINE_DETAIL = panels.regexPanel.quarantinedDetail
const CLEAR_ARIA = 'Clear the quarantine on hung-script and run it again'

function mountedScriptIds(host: HTMLElement) {
  return [...host.querySelectorAll('[data-spindle-mount="regex_entry_row"]')]
    .map((element) => element.getAttribute('data-spindle-scope')!.slice('regex-entry:'.length, -':row'.length))
}

function largeFolder(count = 584, folder = 'Large folder') {
  return Array.from({ length: count }, (_, i) => script(`rule-${String(i).padStart(4, '0')}`, { folder }))
}

beforeAll(async () => {
  await englishI18n.use(initReactI18next).init({
    resources: { en: { panels, shared, common } },
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'panels',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

  // dnd-kit and ReactDOM must evaluate after JSDOM installs browser globals.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ resetRegexEvidenceForTests } = await import('@/lib/regex/evidence'))
  ;({ default: RegexPanel } = await import('./RegexPanel'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()
  resetRegexEvidenceForTests()
  evidenceReports.length = 0
  successToasts.length = 0
  errorToasts.length = 0
  storedRegexFolders = []
  putSetting.mockClear()
  reportEvidenceImpl = async () => ({})
  loadRegexScripts.mockClear()
  updateRegexScript.mockClear()
})

describe('RegexPanel quarantine recovery', () => {
  test('a quarantined script exposes a labelled badge and a clear control that persists quarantined:false', async () => {
    const hung = script('hung-script', { metadata: { regex_evidence: { quarantined: true } } })
    storeState = baseStoreState([hung])

    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, panels.regexPanel.uncategorized))

    // Collapsed row: the badge is announced, not colour-only.
    const badge = byAriaLabel(host, QUARANTINE_DETAIL)
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('title')).toBe(QUARANTINE_DETAIL)
    expect(badge?.textContent).toContain(panels.regexPanel.quarantined)

    // Expanding the row surfaces the recovery control.
    expect(byAriaLabel(host, CLEAR_ARIA)).toBeNull()
    await click(badge!)

    const clearButton = byAriaLabel(host, CLEAR_ARIA) as HTMLButtonElement | null
    expect(clearButton).not.toBeNull()
    expect(clearButton?.tagName).toBe('BUTTON')
    expect(clearButton?.textContent).toContain(panels.regexPanel.clearQuarantine)
    expect(host.textContent).toContain(QUARANTINE_DETAIL)

    await click(clearButton!)

    expect(evidenceReports).toEqual([{ id: 'hung-script', payload: { quarantined: false } }])
    expect(loadRegexScripts).toHaveBeenCalledTimes(2) // mount effect + post-clear refetch
    expect(successToasts).toEqual(['"hung-script" is no longer quarantined and will run again.'])
    expect(errorToasts).toEqual([])
    // No write was issued to clear it: the evidence endpoint owns the flag.
    expect(updateRegexScript).not.toHaveBeenCalled()

    // The overlay is authoritative, so the affordance disappears even though the
    // store row still carries the stale metadata until the refetch lands.
    expect(byAriaLabel(host, CLEAR_ARIA)).toBeNull()
    expect(byAriaLabel(host, QUARANTINE_DETAIL)).toBeNull()
  })

  test('a script that is not quarantined renders neither the badge nor the clear control', async () => {
    storeState = baseStoreState([script('healthy-script')])

    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, panels.regexPanel.uncategorized))

    expect(byAriaLabel(host, QUARANTINE_DETAIL)).toBeNull()
    expect(host.textContent).not.toContain(QUARANTINE_DETAIL)
    expect(evidenceReports).toEqual([])
  })

  test('a metadata-only refetch surfaces the quarantine badge and a working clear action', async () => {
    const original = script('hung-script')
    storeState = baseStoreState([original])
    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, panels.regexPanel.uncategorized))
    expect(byAriaLabel(host, QUARANTINE_DETAIL)).toBeNull()

    storeState.regexScripts = [{ ...original, metadata: { regex_evidence: { quarantined: true } } }]
    await rerender(host)

    const badge = byAriaLabel(host, QUARANTINE_DETAIL)
    expect(badge).not.toBeNull()
    await click(badge!)
    await click(byAriaLabel(host, CLEAR_ARIA)!)
    expect(evidenceReports).toEqual([{ id: original.id, payload: { quarantined: false } }])
    expect(byAriaLabel(host, QUARANTINE_DETAIL)).toBeNull()
  })

  test('a failed clear surfaces the server error and leaves the panel usable', async () => {
    const hung = script('hung-script', { metadata: { regex_evidence: { quarantined: true } } })
    storeState = baseStoreState([hung])
    reportEvidenceImpl = async () => {
      throw Object.assign(new Error('request failed'), { body: { error: 'Script is read-only' } })
    }

    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, panels.regexPanel.uncategorized))
    await click(byAriaLabel(host, QUARANTINE_DETAIL)!)
    await click(byAriaLabel(host, CLEAR_ARIA)!)

    expect(evidenceReports).toEqual([{ id: 'hung-script', payload: { quarantined: false } }])
    expect(errorToasts).toEqual(['Script is read-only'])
    expect(successToasts).toEqual([])
  })
})

describe('RegexPanel folders', () => {
  test('folders start collapsed, including folders loaded after mounting', async () => {
    storedRegexFolders = ['Empty folder']
    storeState = baseStoreState([])
    const host = await mount(<RegexPanel />)
    expect(folderHeader(host, 'Empty folder').getAttribute('aria-expanded')).toBe('false')

    storeState.regexScripts = [
      script('first-script', { folder: 'First folder' }),
      script('second-script', { folder: 'Second folder' }),
      script('uncategorized-script'),
    ]
    await rerender(host)

    for (const name of ['First folder', 'Second folder', panels.regexPanel.uncategorized]) {
      expect(folderHeader(host, name).getAttribute('aria-expanded')).toBe('false')
    }
    expect(host.textContent).not.toContain('first-script')
    expect(host.textContent).not.toContain('second-script')
    expect(host.textContent).not.toContain('uncategorized-script')

    await click(folderHeader(host, 'First folder'))
    expect(host.textContent).toContain('first-script')
    expect(host.textContent).not.toContain('second-script')

    storeState.regexScripts = [
      ...(storeState.regexScripts as RegexScript[]),
      script('third-script', { folder: 'Third folder' }),
    ]
    await rerender(host)
    expect(folderHeader(host, 'First folder').getAttribute('aria-expanded')).toBe('true')
    expect(folderHeader(host, 'Third folder').getAttribute('aria-expanded')).toBe('false')
    await click(folderHeader(host, 'First folder'))
    expect(host.textContent).not.toContain('first-script')
  })

  test('adding a script opens its folder and editor', async () => {
    const newScript = script('new-script')
    const addRegexScript = jest.fn(async () => {
      storeState.regexScripts = [newScript]
      return newScript
    })
    storeState = { ...baseStoreState([]), addRegexScript }
    const host = await mount(<RegexPanel />)

    await click(host.querySelector<HTMLElement>('button[title="Add"]')!)
    await click(menuButton(panels.regexPanel.newScript))

    expect(folderHeader(host, panels.regexPanel.uncategorized).getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector<HTMLInputElement>('input[value="new-script"]')).not.toBeNull()
  })

  test('right-click offers rename and the existing folder actions without expanding', async () => {
    storeState = {
      ...baseStoreState([script('folder-script', { folder: 'Reusable targets' })]),
      activeLoomPresetId: 'preset-1',
    }
    const host = await mount(<RegexPanel />)
    await openFolderMenu(host, 'Reusable targets')

    for (const label of [
      'Rename Reusable targets',
      'Disable all scripts in "Reusable targets"',
      'Bind "Reusable targets" to active preset',
      'Export scripts in "Reusable targets"',
      'Delete all scripts in "Reusable targets"',
    ]) {
      expect(menuButton(label)).toBeDefined()
    }
    expect(folderHeader(host, 'Reusable targets').getAttribute('aria-expanded')).toBe('false')
    // The buttons on the header remain available too.
    expect(byAriaLabel(host, 'Disable all scripts in Reusable targets')).not.toBeNull()
    expect(byAriaLabel(host, 'Export scripts in Reusable targets')).not.toBeNull()

    await click(menuButton('Disable all scripts in "Reusable targets"'))
    expect(storeState.toggleRegexFolder).toHaveBeenCalledWith('Reusable targets', true)
    expect(document.body.textContent).not.toContain('Rename Reusable targets')

    await openFolderMenu(host, 'Reusable targets')
    await click(menuButton('Bind "Reusable targets" to active preset'))
    expect(updateRegexScript).toHaveBeenCalledWith('folder-script', { preset_id: 'preset-1' })

    await openFolderMenu(host, 'Reusable targets')
    await click(menuButton('Delete all scripts in "Reusable targets"'))
    expect(document.body.textContent).toContain('Delete all 1 regex scripts in "Reusable targets"?')
    expect(storeState.bulkRemoveRegexScripts).not.toHaveBeenCalled()
  })

  test('touch hold opens the folder menu and suppresses the release click', async () => {
    storeState = baseStoreState([script('folder-script', { folder: 'Reusable targets' })])
    const host = await mount(<RegexPanel />)
    const header = folderHeader(host, 'Reusable targets')
    await act(async () => {
      header.dispatchEvent(new domWindow.TouchEvent('touchstart', {
        bubbles: true, cancelable: true,
        touches: [{ clientX: 80, clientY: 100 } as Touch],
      }))
      await new Promise((resolve) => setTimeout(resolve, 550))
    })

    expect(menuButton('Rename Reusable targets')).toBeDefined()
    const release = new domWindow.TouchEvent('touchend', { bubbles: true, cancelable: true })
    await act(async () => { header.dispatchEvent(release) })
    expect(release.defaultPrevented).toBe(true)
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })

  test('renaming a folder updates scripts across scopes and preserves its expanded state', async () => {
    storedRegexFolders = ['Reusable targets']
    const renameScript = jest.fn(async (id: string, updates: Partial<RegexScript>) => {
      storeState.regexScripts = (storeState.regexScripts as RegexScript[])
        .map((existing) => existing.id === id ? { ...existing, ...updates } : existing)
    })
    storeState = {
      ...baseStoreState([
        script('global-script', { folder: 'Reusable targets' }),
        script('character-script', { folder: 'Reusable targets', scope: 'character', scope_id: 'char-1' }),
        script('other-script', { folder: 'Other folder' }),
      ]),
      updateRegexScript: renameScript,
    }
    const host = await mount(<RegexPanel />)
    await click(menuButton(panels.regexPanel.scopeGlobal))
    await click(folderHeader(host, 'Reusable targets'))
    await openFolderMenu(host, 'Reusable targets')
    await click(menuButton('Rename Reusable targets'))

    const input = byAriaLabel(host, panels.regexPanel.folderName) as HTMLInputElement
    expect(input.value).toBe('Reusable targets')
    expect(document.activeElement).toBe(input)
    await changeInput(input, '  Updated targets  ')
    await act(async () => {
      input.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })

    expect(renameScript.mock.calls).toEqual([
      ['global-script', { folder: 'Updated targets' }],
      ['character-script', { folder: 'Updated targets' }],
    ])
    expect(folderHeader(host, 'Updated targets').getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('global-script')
    expect(host.textContent).not.toContain('character-script')
    expect(host.textContent).not.toContain('Reusable targets')
    expect(byAriaLabel(host, panels.regexPanel.folderName)).toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(storedRegexFolders).toEqual(['Updated targets'])
  })

  test('renames a persisted empty folder and keeps it collapsed', async () => {
    storedRegexFolders = ['Reusable targets']
    storeState = baseStoreState([])
    const host = await mount(<RegexPanel />)
    await openFolderMenu(host, 'Reusable targets')
    await click(menuButton('Rename Reusable targets'))
    await changeInput(byAriaLabel(host, panels.regexPanel.folderName) as HTMLInputElement, 'Updated targets')
    await click(byAriaLabel(host, shared.folderDropdown.confirmRename)!)

    expect(folderHeader(host, 'Updated targets').getAttribute('aria-expanded')).toBe('false')
    expect(host.textContent).not.toContain('Reusable targets')
    expect(updateRegexScript).not.toHaveBeenCalled()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(storedRegexFolders).toEqual(['Updated targets'])
  })

  test('blank names cannot be submitted and Escape cancels renaming', async () => {
    storeState = baseStoreState([script('folder-script', { folder: 'Reusable targets' })])
    const host = await mount(<RegexPanel />)
    await openFolderMenu(host, 'Reusable targets')
    await click(menuButton('Rename Reusable targets'))
    const input = byAriaLabel(host, panels.regexPanel.folderName) as HTMLInputElement
    await changeInput(input, '   ')
    expect((byAriaLabel(host, shared.folderDropdown.confirmRename) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      input.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(byAriaLabel(host, panels.regexPanel.folderName)).toBeNull()
    expect(folderHeader(host, 'Reusable targets').getAttribute('aria-expanded')).toBe('false')
    expect(updateRegexScript).not.toHaveBeenCalled()
  })

  test('keyboard users can open the menu and cancel without submitting a rename', async () => {
    storeState = baseStoreState([script('folder-script', { folder: 'Reusable targets' })])
    const host = await mount(<RegexPanel />)
    await act(async () => {
      folderHeader(host, 'Reusable targets').dispatchEvent(new domWindow.KeyboardEvent('keydown', {
        key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
      }))
    })
    await click(menuButton('Rename Reusable targets'))
    await changeInput(byAriaLabel(host, panels.regexPanel.folderName) as HTMLInputElement, 'Updated targets')
    const cancel = byAriaLabel(host, shared.folderDropdown.cancelRename)!
    await act(async () => {
      cancel.dispatchEvent(new domWindow.KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }))
    })
    // JSDOM does not synthesize the button's click after Enter.
    await click(cancel)

    expect(updateRegexScript).not.toHaveBeenCalled()
    expect(byAriaLabel(host, panels.regexPanel.folderName)).toBeNull()
    expect(folderHeader(host, 'Reusable targets').getAttribute('aria-expanded')).toBe('false')
  })

  test('a failed rename keeps the original folder and editor available for retry', async () => {
    storedRegexFolders = ['Reusable targets']
    const renameScript = jest.fn(async () => {
      throw Object.assign(new Error('request failed'), { body: { error: 'Unable to rename script' } })
    })
    storeState = {
      ...baseStoreState([script('folder-script', { folder: 'Reusable targets' })]),
      updateRegexScript: renameScript,
    }
    const host = await mount(<RegexPanel />)
    await openFolderMenu(host, 'Reusable targets')
    await click(menuButton('Rename Reusable targets'))
    await changeInput(byAriaLabel(host, panels.regexPanel.folderName) as HTMLInputElement, 'Updated targets')
    await click(byAriaLabel(host, shared.folderDropdown.confirmRename)!)

    expect(errorToasts).toEqual(['Unable to rename script'])
    expect(storedRegexFolders).toEqual(['Reusable targets'])
    expect((byAriaLabel(host, panels.regexPanel.folderName) as HTMLInputElement).disabled).toBe(false)
    expect(putSetting).not.toHaveBeenCalled()
  })

  test('scoped views omit folders that contain no matching scripts', async () => {
    storedRegexFolders = ['Empty folder']
    storeState = {
      ...baseStoreState([
        script('global-script', { folder: 'Global folder' }),
        script('matching-chat-script', { folder: 'Matching chat folder', scope: 'chat', scope_id: 'chat-1' }),
        script('other-chat-script', { folder: 'Other chat folder', scope: 'chat', scope_id: 'chat-2' }),
      ]),
      activeChatId: 'chat-1',
    }

    const host = await mount(<RegexPanel />)

    expect(host.textContent).toContain('Empty folder')
    expect(host.textContent).toContain('Global folder')
    expect(host.textContent).toContain('Matching chat folder')
    expect(host.textContent).toContain('Other chat folder')

    const chatScopeButton = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === panels.regexPanel.scopeThisChat)
    expect(chatScopeButton).not.toBeUndefined()
    await click(chatScopeButton!)

    expect(host.textContent).toContain('Matching chat folder')
    expect(host.textContent).not.toContain('Empty folder')
    expect(host.textContent).not.toContain('Global folder')
    expect(host.textContent).not.toContain('Other chat folder')
  })

  test('creating a folder with no scripts renders a blank folder target', async () => {
    storeState = baseStoreState([])
    const host = await mount(<RegexPanel />)

    expect(host.textContent).toContain(panels.regexPanel.noScripts)

    await click(host.querySelector<HTMLElement>('button[title="Add"]')!)
    const newFolderButton = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(panels.regexPanel.newFolder))
    expect(newFolderButton).not.toBeUndefined()
    await click(newFolderButton!)

    const folderInput = host.querySelector<HTMLInputElement>(`input[placeholder="${panels.regexPanel.folderName}"]`)
    expect(folderInput).not.toBeNull()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')?.set
      setValue?.call(folderInput, 'Post-processing')
      folderInput!.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      folderInput!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    expect(host.textContent).toContain('Post-processing')
    expect(host.textContent).not.toContain(panels.regexPanel.noScripts)
    expect(host.querySelector('[role="button"]')?.textContent).toContain('Post-processing0')
  })

  test('renders a previously persisted folder when the regex library is empty', async () => {
    storedRegexFolders = ['Reusable targets']
    storeState = baseStoreState([])

    const host = await mount(<RegexPanel />)

    expect(host.textContent).toContain('Reusable targets')
    expect(host.textContent).not.toContain(panels.regexPanel.noScripts)
  })

  test('deletes a persisted empty folder after confirmation', async () => {
    storedRegexFolders = ['Reusable targets']
    storeState = baseStoreState([])

    const host = await mount(<RegexPanel />)
    await click(byAriaLabel(host, 'Delete all scripts in Reusable targets')!)
    await click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!)

    expect(host.textContent).not.toContain('Reusable targets')
    expect(host.textContent).toContain(panels.regexPanel.noScripts)
  })

  test('removes a populated folder from settings after all scripts are deleted', async () => {
    storedRegexFolders = ['Reusable targets']
    const folderScript = script('folder-script', { folder: 'Reusable targets' })
    const bulkRemoveRegexScripts = jest.fn(async () => 1)
    storeState = {
      ...baseStoreState([folderScript]),
      bulkRemoveRegexScripts,
    }

    const host = await mount(<RegexPanel />)
    await click(byAriaLabel(host, 'Delete all scripts in Reusable targets')!)
    await click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!)

    expect(bulkRemoveRegexScripts).toHaveBeenCalledWith(['folder-script'])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(storedRegexFolders).toEqual([])
  })

  test('keeps a populated folder in settings when some scripts cannot be deleted', async () => {
    storedRegexFolders = ['Reusable targets']
    const scripts = [
      script('deletable-script', { folder: 'Reusable targets' }),
      script('protected-script', { folder: 'Reusable targets' }),
    ]
    const bulkRemoveRegexScripts = jest.fn(async () => 1)
    storeState = {
      ...baseStoreState(scripts),
      bulkRemoveRegexScripts,
    }

    const host = await mount(<RegexPanel />)
    await click(byAriaLabel(host, 'Delete all scripts in Reusable targets')!)
    await click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!)

    expect(bulkRemoveRegexScripts).toHaveBeenCalledWith(['deletable-script', 'protected-script'])
    expect(storedRegexFolders).toEqual(['Reusable targets'])
    expect(errorToasts).toEqual(['1 scripts could not be deleted'])
  })
})

describe('RegexPanel large folders', () => {
  test('opening a 584-script folder mounts only 50 sortable rows and pages through all scripts', async () => {
    const scripts = largeFolder()
    storeState = baseStoreState(scripts)
    const host = await mount(<RegexPanel />)
    expect(mountedScriptIds(host)).toEqual([])
    await click(folderHeader(host, 'Large folder'))
    expect(mountedScriptIds(host)).toEqual(scripts.slice(0, 50).map((s) => s.id))
    expect(host.querySelectorAll(`[aria-label="${panels.regexPanel.dragToFolderAria}"]`)).toHaveLength(50)

    await click(byAriaLabel(host, shared.pagination.nextPage)!)
    expect(mountedScriptIds(host)).toEqual(scripts.slice(50, 100).map((s) => s.id))
    const pages = byAriaLabel(host, 'Script pages in Large folder')!
    await click([...pages.querySelectorAll('button')].find((button) => button.textContent === '12')!)
    expect(mountedScriptIds(host)).toEqual(scripts.slice(550).map((s) => s.id))
    expect((byAriaLabel(host, shared.pagination.nextPage) as HTMLButtonElement).disabled).toBe(true)
  })

  test('literal search finds patterns beyond the current page and resets pagination', async () => {
    const scripts = largeFolder()
    scripts[583].find_regex = '(a+)+$[LATE-MATCH]'
    storeState = baseStoreState(scripts)
    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, 'Large folder'))
    await click(byAriaLabel(host, shared.pagination.nextPage)!)
    const search = byAriaLabel(host, 'Search scripts in Large folder') as HTMLInputElement
    await changeInput(search, '(A+)+$[late-match]')
    expect(mountedScriptIds(host)).toEqual([scripts[583].id])
    expect(byAriaLabel(host, 'Script pages in Large folder')).toBeNull()

    await changeInput(search, 'absent pattern')
    expect(mountedScriptIds(host)).toEqual([])
    expect(host.textContent).toContain(panels.regexPanel.noSearchResults)
    await changeInput(search, '')
    expect(mountedScriptIds(host)).toEqual(scripts.slice(0, 50).map((s) => s.id))
  })

  test('clamps the page after scripts are deleted by another tab', async () => {
    const scripts = largeFolder(51)
    storeState = baseStoreState(scripts)
    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, 'Large folder'))
    await click(byAriaLabel(host, shared.pagination.nextPage)!)
    expect(mountedScriptIds(host)).toEqual([scripts[50].id])

    storeState.regexScripts = scripts.slice(0, 30)
    await rerender(host)
    expect(mountedScriptIds(host)).toEqual(scripts.slice(0, 30).map((s) => s.id))
  })

  test('folder bulk selection includes scripts on other pages and outside the search results', async () => {
    const scripts = largeFolder()
    storeState = baseStoreState(scripts)
    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, 'Large folder'))
    await changeInput(byAriaLabel(host, 'Search scripts in Large folder') as HTMLInputElement, scripts[583].name)
    await click(byAriaLabel(host, panels.regexPanel.bulkSelect)!)
    await click(byAriaLabel(host, 'Select all scripts in Large folder')!)
    expect(host.textContent).toContain('584 of 584 selected')
    await click(host.querySelector<HTMLElement>(`button[title="${panels.regexPanel.disableSelected}"]`)!)
    expect(storeState.toggleSelectedRegexScripts).toHaveBeenCalledWith(scripts.map((s) => s.id), true)
  })

  test('page changes flush pending inline edits before a row unmounts', async () => {
    const scripts = largeFolder(51)
    storeState = baseStoreState(scripts)
    const host = await mount(<RegexPanel />)
    await click(folderHeader(host, 'Large folder'))
    await click(host.querySelector<HTMLElement>('[data-spindle-mount="regex_entry_row"]')!.parentElement!)
    await changeInput(host.querySelector<HTMLInputElement>(`input[value="${scripts[0].name}"]`)!, 'Edited name')
    await click(byAriaLabel(host, shared.pagination.nextPage)!)
    expect(updateRegexScript).toHaveBeenCalledWith(scripts[0].id, { name: 'Edited name' })
    expect(mountedScriptIds(host)).toEqual([scripts[50].id])
  })

  test('adding a script reveals its editor on the last page', async () => {
    const scripts = largeFolder(50, '')
    const newScript = script('new-script')
    storeState = {
      ...baseStoreState(scripts),
      addRegexScript: jest.fn(async () => {
        storeState.regexScripts = [...scripts, newScript]
        return newScript
      }),
    }
    const host = await mount(<RegexPanel />)
    await click(host.querySelector<HTMLElement>('button[title="Add"]')!)
    await click(menuButton(panels.regexPanel.newScript))
    expect(mountedScriptIds(host)).toEqual([newScript.id])
    expect(host.querySelector<HTMLInputElement>('input[value="new-script"]')).not.toBeNull()
  })
})
