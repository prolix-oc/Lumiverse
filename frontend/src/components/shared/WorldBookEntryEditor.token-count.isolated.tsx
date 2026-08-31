import { afterAll, afterEach, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useCallback, useEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import type { WorldBookEntry } from '@/types/api'

const countResult = jest.fn()

mock.module('@/hooks/useTokenCounts', () => ({
  useTokenCounts: ({ content, enabled = true }: { content: string; enabled?: boolean }) => {
    const [status, setStatus] = useState<'idle' | 'counting'>('idle')
    const [count, setCount] = useState<number | null>(null)

    useEffect(() => {
      if (!enabled) setStatus('idle')
    }, [enabled])

    const requestCount = useCallback(() => {
      if (!enabled || !content.trim() || status === 'counting') return
      setStatus('counting')
      void Promise.resolve(countResult(content)).then(
        (result: { token_count: number }) => {
          setCount(result.token_count)
          setStatus('idle')
        },
        () => setStatus('idle'),
      )
    }, [content, enabled, status])

    return { count, approximate: false, status, requestCount }
  },
}))

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
mock.module('lucide-react', () => ({ ChevronRight: () => null, Hash: () => null }))
mock.module('@/store', () => ({ useStore: jest.fn() }))
mock.module('@/components/shared/Spinner', () => ({ Spinner: () => null }))
mock.module('@/components/shared/Toggle', () => ({
  Toggle: {
    Checkbox: ({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: () => void }) =>
      createElement('label', null,
        createElement('input', { type: 'checkbox', checked, disabled, onChange }),
        label,
      ),
  },
}))
mock.module('./NumberStepper', () => ({
  default: ({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) =>
    createElement('input', {
      type: 'number',
      value: value ?? '',
      onChange: (event: { currentTarget: HTMLInputElement }) => onChange(Number(event.currentTarget.value)),
    }),
}))
mock.module('@/components/shared/ExpandedTextEditor', () => ({
  ExpandableTextarea: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement('div', { 'data-expandable-textarea-wrapper': 'true' },
      createElement('textarea', {
        value,
        onChange: (event: { currentTarget: HTMLTextAreaElement }) => onChange(event.currentTarget.value),
      }),
    ),
}))
mock.module('@/lib/worldBookVectorization', () => ({
  getVectorIndexStatusDescription: () => '',
  getVectorIndexStatusLabel: () => '',
}))
mock.module('@/lib/i18n/worldBookEntryLabels', () => ({
  useWorldBookEntryLabels: () => ({
    positionOptions: [],
    roleOptions: [],
    selectiveLogicOptions: [],
  }),
}))
mock.module('@/lib/i18n/loomOptionLabels', () => ({
  useLoomOptionLabels: () => ({
    addableMarkers: [],
    markerLabel: (value: string) => value,
    markerSectionLabel: (value: string) => value,
  }),
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals: Record<string, unknown> = {
  window: globalObject.window,
  document: globalObject.document,
  HTMLElement: globalObject.HTMLElement,
  HTMLButtonElement: globalObject.HTMLButtonElement,
  HTMLInputElement: globalObject.HTMLInputElement,
  HTMLTextAreaElement: globalObject.HTMLTextAreaElement,
  Event: globalObject.Event,
  MouseEvent: globalObject.MouseEvent,
  Node: globalObject.Node,
  IS_REACT_ACT_ENVIRONMENT: globalObject.IS_REACT_ACT_ENVIRONMENT,
}
const domWindow = dom.window as unknown as Window & typeof globalThis
Object.assign(globalObject, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  Node: domWindow.Node,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { createRoot } = await import('react-dom/client')
const { default: WorldBookEntryEditor } = await import('./WorldBookEntryEditor')
mock.restore()
let root: Root | null = null
let container: HTMLDivElement | null = null

function entry(content = 'before', overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    id: 'entry-1',
    world_book_id: 'book-1',
    uid: '1',
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [],
    keysecondary: [],
    content,
    comment: '',
    position: 0,
    depth: 0,
    role: 'system',
    order_value: 0,
    selective: false,
    constant: false,
    disabled: false,
    group_name: '',
    group_override: false,
    group_weight: 0,
    probability: 100,
    scan_depth: null,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: false,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: false,
    vectorized: false,
    vector_index_status: 'not_enabled',
    vector_indexed_at: null,
    vector_index_error: null,
    revision: 1,
    extensions: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

async function renderEditor(
  onUpdate: ReturnType<typeof jest.fn>,
  density: 'default' | 'compact' = 'default',
  currentEntry = entry(),
) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(WorldBookEntryEditor, {
      density,
      entry: currentEntry,
      onUpdate,
      onImmediateUpdate: jest.fn(),
    }))
  })

  const countButton = container.querySelector('button[title="countTokensTitle"]') as HTMLButtonElement
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  expect(countButton).toBeTruthy()
  expect(textarea).toBeTruthy()
  return { countButton, textarea }
}

function changeContent(textarea: HTMLTextAreaElement, content: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  valueSetter?.call(textarea, content)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function disclosure(label: string) {
  const button = [...(container?.querySelectorAll<HTMLButtonElement>('button[aria-controls]') ?? [])]
    .find((candidate) => candidate.textContent?.includes(label))
  expect(button).toBeTruthy()
  const panel = container?.querySelector<HTMLDivElement>(`#${button?.getAttribute('aria-controls')}`)
  expect(panel).toBeTruthy()
  return { button: button!, panel: panel! }
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  countResult.mockReset()
})

afterAll(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('WorldBookEntryEditor token counting', () => {
  test('updates content synchronously while a token count is pending', async () => {
    const pending = Promise.withResolvers<{ token_count: number }>()
    let settled = false
    pending.promise.then(() => { settled = true }, () => { settled = true })
    const onUpdate = jest.fn()
    countResult.mockReturnValueOnce(pending.promise)
    const { countButton, textarea } = await renderEditor(onUpdate)

    await act(async () => countButton.click())
    expect(countResult).toHaveBeenCalledTimes(1)
    expect(countResult).toHaveBeenCalledWith('before')
    expect(countButton.disabled).toBe(true)

    await act(async () => changeContent(textarea, 'after'))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith('entry-1', { content: 'after' })
    expect(settled).toBe(false)

    await act(async () => {
      pending.resolve({ token_count: 1 })
      await pending.promise
    })
  })

  test('updates content after a failed count without an unhandled rejection', async () => {

    const onUpdate = jest.fn()
    const unhandled: unknown[] = []
    const onUnhandledRejection = (event: PromiseRejectionEvent) => unhandled.push(event.reason)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    countResult.mockRejectedValueOnce(new Error('tokenizer unavailable'))
    try {
      const { countButton, textarea } = await renderEditor(onUpdate)
      await act(async () => {
        countButton.click()
        await Promise.resolve()
      })

      await act(async () => changeContent(textarea, 'saved despite failed count'))
      expect(onUpdate).toHaveBeenCalledTimes(1)
      expect(onUpdate).toHaveBeenCalledWith('entry-1', { content: 'saved despite failed count' })
      expect(unhandled).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  })
})

describe('WorldBookEntryEditor compact layout', () => {
  test('keeps Content mounted while compact disclosures are operable and retain mounted values', async () => {
    const onUpdate = jest.fn()
    await renderEditor(onUpdate, 'compact', entry('Long content '.repeat(200), {
      comment: 'Pocket dimension',
      position: 4,
      depth: 3,
      group_name: 'kept group value',
      disabled: true,
      use_regex: true,
      vectorized: true,
    }))

    const editor = container?.querySelector<HTMLElement>('[data-world-book-entry-editor]')
    const contentRegion = container?.querySelector<HTMLElement>('[data-content-flex-region]')
    const textarea = contentRegion?.querySelector<HTMLTextAreaElement>('textarea')
    expect(editor?.getAttribute('data-editor-scroll-owner')).toBe('true')
    expect(container?.querySelector('[data-world-book-identity-content="true"]')).toBeTruthy()
    expect(contentRegion).toBeTruthy()
    expect(textarea?.value).toContain('Long content')

    const injection = disclosure('sections.injection')
    expect(injection.button.tagName).toBe('BUTTON')
    expect(injection.button.getAttribute('type')).toBe('button')
    expect(injection.button.getAttribute('aria-expanded')).toBe('false')
    expect(injection.panel.hidden).toBe(true)
    expect(injection.panel.getAttribute('aria-labelledby')).toBe(injection.button.id)
    expect(injection.button.textContent).toContain('fields.depth: 3')

    const activation = disclosure('sections.activation')
    expect(activation.panel.hidden).toBe(true)
    expect(activation.button.textContent).toContain('toggles.disabled')
    expect(activation.button.textContent).toContain('toggles.useRegex')
    expect(activation.button.textContent).toContain('toggles.vectorized')
    const panelIds = [...(container?.querySelectorAll<HTMLElement>('[data-entry-disclosure] > [role="group"]') ?? [])]
      .map((panel) => panel.id)
    expect(new Set(panelIds).size).toBe(panelIds.length)

    await act(async () => injection.button.click())
    expect(injection.panel.hidden).toBe(false)

    const group = disclosure('sections.group')
    await act(async () => group.button.click())
    const groupInput = group.panel.querySelector<HTMLInputElement>('input[type="text"]')
    expect(groupInput?.value).toBe('kept group value')
    groupInput?.focus()
    await act(async () => group.button.click())
    expect(group.panel.hidden).toBe(true)
    expect(document.activeElement).toBe(group.button)
    await act(async () => group.button.click())
    expect(group.panel.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('kept group value')

    await act(async () => changeContent(textarea!, 'saved after disclosure changes'))
    expect(onUpdate).toHaveBeenCalledWith('entry-1', { content: 'saved after disclosure changes' })
  })

  test('keeps default density on the static expanded injection and activation path', async () => {
    await renderEditor(jest.fn(), 'default', entry('before', { position: 4 }))
    const editor = container?.querySelector<HTMLElement>('[data-world-book-entry-editor]')
    expect(editor?.getAttribute('data-editor-scroll-owner')).toBeNull()
    expect(container?.querySelector('[data-entry-disclosure$="-injection"]')).toBeNull()
    expect(container?.querySelector('[data-entry-disclosure$="-activation"]')).toBeNull()
    expect([...container?.querySelectorAll('span') ?? []].some((node) => node.textContent === 'sections.injection')).toBe(true)
    expect(container?.querySelector<HTMLSelectElement>('select')).toBeTruthy()
  })

  test('defines the compact flex, nested-scroll, and narrow overflow contracts', async () => {
    const source = await Bun.file(new URL('./WorldBookEntryEditor.module.css', import.meta.url)).text()
    const component = await Bun.file(new URL('./WorldBookEntryEditor.tsx', import.meta.url)).text()

    expect(component).toContain('data-content-flex-region="true"')
    expect(component).toContain("data-editor-scroll-owner={density === 'compact' ? 'true' : undefined}")
    expect(component).toContain('hidden={!open}')
    expect(source).toContain('container-name: wbEntryEditorCompact')
    expect(source).toContain('.compactEntryEditor .identityContentSection')
    expect(source).toContain('flex: 1 1 240px')
    expect(source).toContain('.compactEntryEditor .contentField > div:not(.fieldLabelRow)')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('@container wbEntryEditorCompact (max-width: 440px)')
    expect(source).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(source).toContain('max-width: 100%')
    expect(source).toContain('.groupToggleLabel')
    expect(source).toContain('flex: 0 1 auto')
    expect(source).toContain('overflow-wrap: anywhere')
  })

})
