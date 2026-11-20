import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { Persona } from '@/types/api'

const updatePersonaInStore = jest.fn()
const updatePersona = jest.fn()
const translate = (key: string) => key

const initialContent = 'alpha beta gamma'

function personaWithContent(content: string): Persona {
  return {
    id: 'persona-1',
    name: 'Test Persona',
    title: '',
    description: '',
    subjective_pronoun: '',
    objective_pronoun: '',
    possessive_pronoun: '',
    reflexive_pronoun: '',
    possessive_pronoun_standalone: '',
    avatar_path: null,
    image_id: null,
    attached_world_book_id: null,
    folder: '',
    is_default: false,
    is_narrator: false,
    metadata: {
      addons: [{
        id: 'addon-1',
        label: 'Details',
        content,
        enabled: true,
        sort_order: 0,
      }],
      attached_global_addons: [],
    },
    created_at: 0,
    updated_at: 0,
  }
}

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}))
mock.module('@/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    modalProps: { personaId: 'persona-1', personaName: 'Test Persona' },
    closeModal: jest.fn(),
    openModal: jest.fn(),
    updatePersona: updatePersonaInStore,
  }),
}))
mock.module('@/api/personas', () => ({
  personasApi: {
    get: () => Promise.resolve(personaWithContent(initialContent)),
    update: updatePersona,
    uploadAddonAvatar: jest.fn(),
    deleteAddonAvatar: jest.fn(),
  },
}))
mock.module('@/api/global-addons', () => ({
  globalAddonsApi: { list: () => Promise.resolve({ data: [] }) },
}))
mock.module('@/api/images', () => ({ imagesApi: { smallUrl: () => '' } }))
mock.module('@/lib/toast', () => ({ toast: { error: jest.fn() } }))
mock.module('@/lib/uuid', () => ({ uuidv7: () => 'new-addon' }))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) =>
    createElement('button', { type: 'button', onClick, disabled }, children),
}))
mock.module('@/components/shared/ExpandedTextEditor', () => ({
  ExpandableTextarea: ({ value, onChange, title }: { value: string; onChange: (value: string) => void; title: string }) =>
    createElement('textarea', {
      'aria-label': title,
      value,
      onChange: (event: { currentTarget: HTMLTextAreaElement }) => onChange(event.currentTarget.value),
    }),
}))
mock.module('lucide-react', () => ({
  Plus: () => null,
  Check: () => null,
  Trash2: () => null,
  Globe: () => null,
  Link2: () => null,
  Unlink: () => null,
  GripVertical: () => null,
  ImagePlus: () => null,
  ImageOff: () => null,
}))
mock.module('@tabler/icons-react', () => ({ IconPlaylistAdd: () => null }))
mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  MouseSensor: class {},
  TouchSensor: class {},
  KeyboardSensor: class {},
  closestCenter: jest.fn(),
  useSensor: jest.fn(),
  useSensors: () => [],
}))
mock.module('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  arrayMove: (items: unknown[]) => items,
  sortableKeyboardCoordinates: jest.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
}))
mock.module('@/lib/dndUiScale', () => ({
  DndContext: ({ children }: { children?: unknown }) => children,
  useScaledSortableStyle: ({ setNodeRef }: { setNodeRef: (node: HTMLElement | null) => void }) => ({
    setNodeRef,
    style: {},
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
  HTMLTextAreaElement: globalObject.HTMLTextAreaElement,
  Event: globalObject.Event,
  Node: globalObject.Node,
  IS_REACT_ACT_ENVIRONMENT: globalObject.IS_REACT_ACT_ENVIRONMENT,
}
const domWindow = dom.window as unknown as Window & typeof globalThis
Object.assign(globalObject, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Event: domWindow.Event,
  Node: domWindow.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { createRoot } = await import('react-dom/client')
const { default: PersonaAddonsModal } = await import('./PersonaAddonsModal')
mock.restore()

let root: Root | null = null
let container: HTMLDivElement | null = null

function changeTextarea(textarea: HTMLTextAreaElement, value: string, caret: number) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  valueSetter?.call(textarea, value)
  textarea.setSelectionRange(caret, caret)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  jest.useFakeTimers()
  updatePersona.mockReset()
  updatePersonaInStore.mockReset()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  jest.useRealTimers()
})

afterAll(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalObject[key]
    else globalObject[key] = value
  }
})

describe('PersonaAddonsModal autosave editing', () => {
  test('keeps a newer middle-of-document edit when an older save completes', async () => {
    const firstSave = Promise.withResolvers<Persona>()
    const secondSave = Promise.withResolvers<Persona>()
    updatePersona
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise)

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(PersonaAddonsModal))
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
    })

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Details"]')
    expect(textarea).toBeTruthy()

    const firstDraft = 'alpha BETA gamma'
    await act(async () => changeTextarea(textarea!, firstDraft, 10))
    await act(async () => jest.advanceTimersByTime(300))
    expect(updatePersona).toHaveBeenCalledTimes(1)

    const latestDraft = 'alpha BETA! gamma'
    await act(async () => changeTextarea(textarea!, latestDraft, 11))
    await act(async () => jest.advanceTimersByTime(300))

    // A second write waits for the first one instead of racing it.
    expect(updatePersona).toHaveBeenCalledTimes(1)

    await act(async () => firstSave.resolve(personaWithContent(firstDraft)))

    expect(textarea!.value).toBe(latestDraft)
    expect(textarea!.selectionStart).toBe(11)
    expect(updatePersona).toHaveBeenCalledTimes(2)
    expect(updatePersona.mock.calls[1]?.[1]?.metadata?.addons?.[0]?.content).toBe(latestDraft)

    await act(async () => secondSave.resolve(personaWithContent(latestDraft)))
    expect(textarea!.value).toBe(latestDraft)
  })
})
