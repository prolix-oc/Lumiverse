import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { create } from 'zustand'
import type { CouncilToolDefinition } from 'lumiverse-spindle-types'
import type { CreateLoomToolInput, LoomTool } from '@/types/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
const globals = globalThis as unknown as Record<string, unknown>
const replacements = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
}
const previousGlobals = new Map(Object.keys(replacements).map((key) => [key, globals[key]]))
Object.assign(globals, replacements)

let remoteTools: CouncilToolDefinition[] = []
function persistTool(input: CreateLoomToolInput): LoomTool {
  const tool = {
    id: 'tool-1', pack_id: 'pack-1', description: '', author_name: '', version: '1.0.0',
    sort_order: 0, created_at: 0, updated_at: 0, input_schema: {}, result_variable: '',
    store_in_deliberation: false, ...input,
  } as LoomTool
  remoteTools = [{
    name: tool.tool_name,
    displayName: tool.display_name,
    description: tool.description,
    prompt: tool.prompt,
    category: 'story_direction',
    inputSchema: tool.input_schema,
    resultVariable: tool.result_variable,
    storeInDeliberation: tool.store_in_deliberation,
  }]
  return tool
}

const createLoomTool = mock(async (_packId: string, input: CreateLoomToolInput) => persistTool(input))
const updateLoomTool = mock(async (_packId: string, _toolId: string, input: CreateLoomToolInput) => persistTool(input))
const getTools = mock(async () => remoteTools)
mock.module('@/api/packs', () => ({ packsApi: { createLoomTool, updateLoomTool } }))
mock.module('@/api/council', () => ({ councilApi: { getTools } }))
mock.module('@/api/spindle', () => ({ spindleApi: {
  getTools: async () => [],
  list: async () => ({ extensions: [], isPrivileged: false }),
} }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
mock.module('@/components/shared/CloseButton', () => ({ CloseButton: () => null }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: () => null }))
const cssProxy = new Proxy({}, { get: (_target, key) => String(key) })
mock.module('./ToolEditorModal.module.css', () => ({ default: cssProxy }))
mock.module('../CouncilManager.module.css', () => ({ default: cssProxy }))
mock.module('@/components/shared/FormComponents.module.css', () => ({ default: cssProxy }))

const { createCouncilSlice } = await import('@/store/slices/council')
const closeModal = mock(() => {})
const onSaved = mock(() => {})
const useTestStore = create<any>((set, get, api) => ({
  ...createCouncilSlice(set, get, api),
  modalProps: { packId: 'pack-1', onSaved },
  closeModal,
}))
mock.module('@/store', () => ({ useStore: useTestStore }))

const { createRoot } = await import('react-dom/client')
const { default: ToolEditorModal } = await import('./ToolEditorModal')
const { default: ToolSelector } = await import('../council/ToolSelector')

let root: Root
let host: HTMLDivElement
function OpenCouncilAndEditor() {
  const tools = useTestStore((s) => s.availableCouncilTools)
  return <>
    <section aria-label="Council tool options"><ToolSelector tools={tools} selected={[]} onChange={() => {}} /></section>
    <ToolEditorModal />
  </>
}

beforeEach(() => {
  remoteTools = []
  createLoomTool.mockClear()
  updateLoomTool.mockClear()
  getTools.mockClear()
  closeModal.mockClear()
  onSaved.mockClear()
  useTestStore.setState({ availableCouncilTools: [], modalProps: { packId: 'pack-1', onSaved } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

afterAll(() => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) Reflect.deleteProperty(globals, key)
    else Reflect.set(globals, key, value)
  }
  dom.window.close()
})

async function fill(field: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="creatorWorkshop.toolEditor.${field}Placeholder"]`)!
  const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

async function save(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((el) => el.textContent === label)!
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
}

describe('custom tool editor council options', () => {
  test('a saved default tool appears in an already mounted picker only after creation succeeds', async () => {
    let finishSave!: () => void
    createLoomTool.mockImplementationOnce((_packId, input) => new Promise((resolve) => {
      finishSave = () => resolve(persistTool(input))
    }))
    await act(async () => root.render(<OpenCouncilAndEditor />))
    await fill('toolName', 'custom_analysis')
    await fill('displayName', 'Custom Analysis')
    await fill('prompt', 'Analyze the scene')
    await save('creatorWorkshop.shared.create')

    expect(getTools).not.toHaveBeenCalled()
    expect(closeModal).not.toHaveBeenCalled()
    await act(async () => finishSave())

    expect(createLoomTool.mock.calls[0][1].store_in_deliberation).toBe(false)
    expect(host.querySelector('[aria-label="Council tool options"]')!.textContent).toContain('Custom Analysis')
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(closeModal).toHaveBeenCalledTimes(1)
  })

  test('editing a variable-only tool refreshes its name in the mounted picker', async () => {
    const editingItem = persistTool({
      tool_name: 'custom_analysis', display_name: 'Original Analysis', prompt: 'Analyze the scene',
      result_variable: 'analysis_result', store_in_deliberation: false,
    })
    useTestStore.setState({ availableCouncilTools: remoteTools, modalProps: { packId: 'pack-1', editingItem, onSaved } })
    await act(async () => root.render(<OpenCouncilAndEditor />))
    await fill('displayName', 'Updated Analysis')
    await save('creatorWorkshop.shared.saveChanges')

    expect(updateLoomTool.mock.calls[0][2]).toMatchObject({ result_variable: 'analysis_result', store_in_deliberation: false })
    const options = host.querySelector('[aria-label="Council tool options"]')!
    expect(options.textContent).toContain('Updated Analysis')
    expect(options.textContent).not.toContain('Original Analysis')
  })
})
