import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { CardUpdatePreview, Character, CharacterUpdateMatchCandidate } from '@/types/api'
import modals from '@/i18n/locales/en/modals.json'
import common from '@/i18n/locales/en/common.json'

const getCharacter = mock()
const applyCardUpdate = mock()
const onApplied = mock()
const onImportAsNew = mock()
const onClose = mock()

mock.module('@/api/characters', () => ({
  charactersApi: {
    get: getCharacter,
    applyCardUpdate,
    avatarUrl: (id: string) => `/api/characters/${id}/avatar`,
  },
}))
mock.module('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const bundle = namespace === 'modals' ? modals : common
      const value = key.split('.').reduce<any>((node, part) => node?.[part], bundle) ?? key
      return String(value).replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => String(values?.[name] ?? ''))
    },
  }),
}))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => (
    isOpen ? <div data-testid="modal-shell">{children}</div> : null
  ),
}))
mock.module('@/components/shared/CloseButton', () => ({
  CloseButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>Close</button>
  ),
}))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}))
mock.module('@/components/shared/Toggle', () => ({
  Toggle: {
    Checkbox: ({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) => (
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    ),
  },
}))
mock.module('@/components/shared/Spinner', () => ({
  Spinner: () => <span>Loading...</span>,
}))
mock.module('@/lib/toast', () => ({
  toast: { success: mock(), error: mock(), info: mock() },
}))

const { default: CardUpdateModal } = await import('./CardUpdateModal')

const existingCharacter: Character = {
  id: 'char-1',
  name: 'Elena',
  avatar_path: null,
  image_id: null,
  description: 'Old bio',
  personality: 'Kind',
  scenario: 'Cafe',
  first_mes: 'Hello there!',
  mes_example: '',
  creator: 'Arch',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  folder: '',
  library_scope: 'mine',
  tags: ['slice-of-life'],
  alternate_greetings: ['Existing greeting 1'],
  talkativeness: 0.5,
  extensions: {},
  created_at: 1,
  updated_at: 1,
}

const preview: CardUpdatePreview = {
  format: 'json',
  filename: 'elena_v2.json',
  incoming: {
    name: 'Elena',
    description: 'Updated bio',
    personality: 'Kind',
    scenario: 'Cafe',
    first_mes: 'Hello there!',
    mes_example: '',
    creator: 'Arch',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['slice-of-life', 'updated'],
    alternate_greetings: ['Existing greeting 1', 'Brand new greeting 2'],
    extensions: {},
  },
  hasAvatar: false,
  avatarPreviewUrl: null,
  extras: {
    embeddedLorebookEntries: 0,
    lumiverseWorldBookCount: 0,
    regexScriptCount: 0,
    expressionCount: 0,
    expressionGroupCount: 0,
    galleryCount: 0,
    alternateAvatarCount: 0,
    alternateFieldKeys: [],
    landingPerspectiveLayerCount: 0,
  },
}

const matches: CharacterUpdateMatchCandidate[] = [
  {
    id: 'char-1',
    name: 'Elena',
    creator: 'Arch',
    image_id: null,
    updated_at: 100,
    matchReason: 'name_and_creator',
  },
]

let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previousGlobals: Record<string, unknown>

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previousGlobals = Object.fromEntries(
    ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Reflect.get(globalThis, key)]),
  )
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  getCharacter.mockReset().mockResolvedValue(existingCharacter)
  applyCardUpdate.mockReset().mockResolvedValue({
    character: {
      ...existingCharacter,
      alternate_greetings: ['Existing greeting 1', 'Brand new greeting 2'],
    },
    summary: {
      updatedFields: ['alternate_greetings'],
      addedAlternateGreetings: 1,
      demotedFirstMes: false,
      avatarUpdated: 'keep',
      worldBooksImported: 0,
      regexScriptsImported: 0,
      charxAssetsApplied: false,
    },
  })
  onApplied.mockReset()
  onImportAsNew.mockReset()
  onClose.mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
    else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('CardUpdateModal', () => {
  test('shows match banner, supports Greetings Only preset, and submits selective update', async () => {
    const file = new File(['{}'], 'elena_v2.json', { type: 'application/json' })

    await act(async () => {
      root.render(
        <CardUpdateModal
          isOpen={true}
          file={file}
          preview={preview}
          matches={matches}
          onImportAsNew={onImportAsNew}
          onApplied={onApplied}
          onClose={onClose}
        />,
      )
    })
    await flush()

    expect(getCharacter).toHaveBeenCalledWith('char-1')
    expect(host.textContent).toContain('Matches existing character "Elena"')
    expect(host.textContent).toContain('Brand new greeting 2')

    const greetingsOnlyBtn = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Greetings only',
    )!
    expect(greetingsOnlyBtn).toBeTruthy()
    await act(async () => {
      greetingsOnlyBtn.click()
    })
    await flush()

    const applyBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Apply Updates'),
    )!
    expect(applyBtn).toBeTruthy()
    await act(async () => {
      applyBtn.click()
    })
    await flush()

    expect(applyCardUpdate).toHaveBeenCalledTimes(1)
    expect(applyCardUpdate.mock.calls[0]?.[0]).toBe('char-1')
    expect(applyCardUpdate.mock.calls[0]?.[2]).toMatchObject({
      fields: [],
      firstMesMode: 'keep',
      alternateGreetingsMode: 'append_new',
      tagsMode: 'keep',
      avatarMode: 'keep',
    })
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  test('triggers Import as New when user clicks Import as New', async () => {
    const file = new File(['{}'], 'elena_v2.json', { type: 'application/json' })
    await act(async () => {
      root.render(
        <CardUpdateModal
          isOpen={true}
          file={file}
          preview={preview}
          matches={matches}
          onImportAsNew={onImportAsNew}
          onApplied={onApplied}
          onClose={onClose}
        />,
      )
    })
    await flush()

    const importAsNewBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Import as New'),
    )!
    await act(async () => {
      importAsNewBtn.click()
    })
    await flush()

    expect(onImportAsNew).toHaveBeenCalledTimes(1)
  })
})
