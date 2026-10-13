import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { act, useSyncExternalStore, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import type { Root } from 'react-dom/client'
import panels from '../../i18n/locales/en/panels.json'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const t = (key: string) => key.split('.').reduce((value: any, part) => value?.[part], panels) || key
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))

const listeners = new Set<() => void>()
let state: any
function patch(values: Record<string, any>) { state = { ...state, ...values }; listeners.forEach(listener => listener()) }
const setImageGenSettings = jest.fn((values: any) => patch({ imageGeneration: { ...state.imageGeneration, ...values } }))
const openModal = jest.fn()
const setImageGenProfiles = jest.fn((profiles: any[]) => patch({ imageGenProfiles: profiles }))
const useStore = Object.assign((selector: (value: any) => any) => {
  const snapshot = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => state)
  return selector(snapshot)
}, { getState: () => state })
mock.module('@/store', () => ({ useStore }))
const generate = jest.fn(async () => ({ imageDataUrl: 'data:image/png;base64,generated' }))
const setCharacterBinding = jest.fn(async (_id: string, preset: string) => ({ preset_id: preset }))
const setPersonaBinding = jest.fn(async (_id: string, preset: string) => ({ preset_id: preset }))
const bindings = {
  getCharacterBinding: jest.fn(async () => ({ preset_id: 'character-preset' })), getPersonaBinding: jest.fn(async () => ({ preset_id: 'persona-preset' })),
  setCharacterBinding, setPersonaBinding, deleteCharacterBinding: jest.fn(async () => {}), deletePersonaBinding: jest.fn(async () => {}),
}
mock.module('@/api/image-gen', () => ({ imageGenApi: { generate, getWorkflowConfig: async () => ({ config: null }), getComfyCapabilities: async () => ({}) }, imageGenPresetBindingsApi: bindings }))
const updateConnection = jest.fn(async () => ({}))
const providerSchema = {
  width: { type: 'integer', default: 512, description: 'Image width' },
  negativePrompt: { type: 'string', description: 'Negative prompt' },
  vae: { type: 'string', group: 'models', description: 'Model component' },
  initImage: { type: 'string', group: 'img2img', description: 'Source' },
  referenceStrength: { type: 'number', group: 'references', description: 'Reference weight' },
  seed: { type: 'integer', group: 'advanced', description: 'Seed' },
  futureKnob: { type: 'string', group: 'future-provider-group', description: 'Future option' },
}
mock.module('@/api/image-gen-connections', () => ({ imageGenConnectionsApi: {
  providers: async () => ({ providers: [] }), update: updateConnection, get: async () => state.imageGenProfiles[0], modelsBySubtype: async () => ({ models: [] }),
} }))
mock.module('@/api/macros', () => ({ getMacroCatalog: async () => ({ categories: [] }) }))
mock.module('@/lib/loom/service', () => ({ getAvailableMacros: () => [] }))
mock.module('@/lib/comfyui-mapped-fields', () => ({ buildMappedFieldControls: () => [] }))
mock.module('@/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
mock.module('@/hooks/useTouchActivate', () => ({ useTouchActivate: (fn: () => void) => ({ onClick: fn }) }))
mock.module('@/components/shared/ModalShell', () => ({ ModalShell: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div>{children}</div> : null }))
mock.module('@/components/shared/FormComponents', () => ({
  FormField: ({ label, hint, children }: any) => <div data-field={label}><label>{label}</label>{children}{hint && <p>{hint}</p>}</div>,
  EditorSection: ({ title, children }: any) => <section><h3>{title}</h3>{children}</section>,
  Button: ({ children, onClick, disabled }: any) => <button type="button" onClick={onClick} disabled={disabled}>{children}</button>,
  Select: ({ value, onChange, options }: any) => <select value={value} onChange={event => onChange(event.target.value)}>{options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
  TextInput: ({ value, onChange, placeholder, type = 'text' }: any) => <input type={type} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />,
  TextArea: ({ value, onChange }: any) => <textarea value={value} onChange={event => onChange(event.target.value)} />,
}))
mock.module('@/components/shared/ConnectionSelect', () => ({ default: ({ kind, value, onChange }: any) => <select aria-label={kind === 'imageGen' ? 'Connection' : 'Parser Connection'} value={value} onChange={event => onChange(event.target.value)}><option value="">Default</option><option value="connection">Connection</option><option value="other">Other</option></select> }))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Checkbox: ({ checked, onChange, label }: any) => <label><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label> } }))
mock.module('@/components/shared/RangeSlider', () => ({ LabeledRangeSlider: ({ label, value, onCommit }: any) => <label>{label}<input aria-label={label} type="number" value={value} onChange={event => onCommit(Number(event.target.value))} /></label> }))
mock.module('@/components/shared/ExpandedTextEditor', () => ({ ExpandableTextarea: ({ value, onChange, title }: any) => <textarea aria-label={title} value={value} onChange={event => onChange(event.target.value)} /> }))
mock.module('@/components/shared/ConfirmationModal', () => ({ default: ({ isOpen, onConfirm, onCancel }: any) => isOpen && <div role="alertdialog"><button onClick={onConfirm}>Confirm delete</button><button onClick={onCancel}>Cancel delete</button></div> }))
mock.module('./imageGenLoraEditor', () => ({
  useLoraDiscovery: () => ({ supportsDiscovery: false, loras: [], state: 'idle' }), LoraDiscoveryStatus: () => null,
  LoraRowsEditor: ({ rows, onChange }: any) => <div data-lora-editor>{rows.map((row: any, index: number) => <div key={row.draftId}><input aria-label="LoRA filename" value={row.lora_name} onChange={event => onChange(rows.map((entry: any, i: number) => i === index ? { ...entry, lora_name: event.target.value } : entry))} /><button onClick={() => onChange(rows.filter((_: any, i: number) => i !== index))}>Remove LoRA</button></div>)}</div>,
}))
mock.module('./ImageGenExportModal', () => ({ default: () => null }))
mock.module('./ImageGenProgressBar', () => ({ default: () => <div>Progress</div> }))
mock.module('./image-gen-connections/ComfyWorkflowEditor', () => ({ ComfyWorkflowEditor: () => <div>Workflow editor</div> }))
mock.module('@/components/shared/ImageLightbox', () => ({ default: () => null }))
const { createRoot } = await import('react-dom/client')
const { default: ImageGenPanel } = await import('./ImageGenPanel')

let root: Root
let host: HTMLDivElement
const preset = (id: string, kind: string, prompt: string) => ({ id, kind, prompt, name: id, mode: 'custom', negativePrompt: `${id}-negative` })
beforeEach(() => {
  jest.useFakeTimers()
  setImageGenSettings.mockClear(); updateConnection.mockClear(); generate.mockClear(); openModal.mockClear()
  setCharacterBinding.mockClear(); setPersonaBinding.mockClear()
  state = {
    imageGeneration: { enabled: true, promptMode: 'custom', customPrompt: 'Initial draft', customNegativePrompt: 'Initial negative', outputTarget: 'background',
      activePromptPresetId: null, promptPresets: [preset('main-preset', 'main', 'Main prompt'), preset('character-preset', 'character', 'Character snippet'), preset('persona-preset', 'persona', 'Persona snippet'), preset('captioning-preset', 'captioning', 'Caption instructions')],
      activeLoraPresetId: 'lora-preset', loraPresets: [{ id: 'lora-preset', name: 'Ink', loras: [{ lora_name: 'ink.safetensors', weight_model: 0.8 }], base_tags: 'ink style' }],
    },
    sceneGenerating: false, sceneBackground: null, activeChatId: 'chat', activeCharacterId: 'character', activePersonaId: 'persona', activeImageGenConnectionId: 'connection',
    imageGenProfiles: [{ id: 'connection', name: 'Test', provider: 'test-provider', model: 'model', default_parameters: {} }, { id: 'other', provider: 'empty-provider', model: 'model', default_parameters: {} }],
    imageGenProviders: [{ id: 'test-provider', name: 'Test Provider', capabilities: { parameters: providerSchema } }, { id: 'empty-provider', capabilities: { parameters: {} } }],
    setImageGenSettings, openModal, setImageGenProfiles, setImageGenProviders: jest.fn(), setSceneBackground: (src: string) => patch({ sceneBackground: src }),
    setSceneGenerating: (value: boolean) => patch({ sceneGenerating: value }), setActiveImageGenConnection: (id: string) => patch({ activeImageGenConnectionId: id }),
  }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); jest.useRealTimers() })
async function render() { await act(async () => root.render(<ImageGenPanel />)); setImageGenSettings.mockClear() }
function button(text: string) { const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text); expect(found).toBeDefined(); return found! }
async function click(text: string) { await act(async () => button(text).click()) }
function field(label: string) { const found = [...host.querySelectorAll<HTMLElement>('[data-field]')].find(node => node.dataset.field === label); expect(found).toBeDefined(); return found! }
async function change(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
async function openPrompt() { await act(async () => field(t('imageGenPanel.activeMainPreset')).querySelector<HTMLButtonElement>('button')!.click()) }
async function openLora() { await act(async () => field(t('imageGenPanel.activeLoraPreset')).querySelector<HTMLButtonElement>('button')!.click()) }

describe('Image Gen runtime drawer and editor boundaries', () => {
  test('drawer keeps runtime controls and actions; deep editors only mount on request', async () => {
    await render()
    expect(host.querySelector('select[aria-label="Connection"]')).not.toBeNull()
    expect(field(t('imageGenPanel.mode'))).toBeDefined(); expect(field(t('imageGenPanel.output'))).toBeDefined()
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(5)
    expect(host.querySelector('textarea')).toBeNull(); expect(host.querySelector('[data-lora-editor]')).toBeNull()
    expect(host.textContent).not.toContain('Future Knob'); expect(host.textContent).not.toContain('Image width')
    expect(button('Configure Generation…')).toBeDefined(); expect(button(t('imageGenPanel.generateNow'))).toBeDefined(); expect(button(t('imageGenPanel.forceGenerate'))).toBeDefined()
    await click('Caption Image'); expect(openModal).toHaveBeenCalledWith('imageCaptioner', {})
    await act(async () => setImageGenSettings({ enabled: false }))
    expect(host.querySelector('select[aria-label="Connection"]')).toBeNull(); expect(button('Caption Image')).toBeDefined(); expect(host.querySelector('details')).toBeNull()
    expect(host.querySelector('[aria-label="Image utilities"]')!.querySelectorAll('button').length).toBe(3)
  })
  test('generation footer contains only generation actions while preview controls scroll separately', async () => {
    await render()
    await act(async () => patch({ sceneBackground: 'data:image/png;base64,preview' }))
    const footer = host.querySelector('[aria-label="Generation actions"]')!
    expect([...footer.querySelectorAll('button')].map(node => node.textContent)).toEqual([t('imageGenPanel.generateNow'), t('imageGenPanel.forceGenerate')])
    expect(footer.contains(button(t('imageGenPanel.clear')))).toBe(false)
  })
  test('runtime main selection carries prompts without replacing the shared parser', async () => {
    await render()
    await act(async () => patch({ imageGeneration: { ...state.imageGeneration, promptParserConnectionId: 'shared', promptParserModel: 'shared-model', promptParserParameters: { temperature: 0.7 }, promptPresets: state.imageGeneration.promptPresets.map((p: any) => p.kind === 'main' ? { ...p, mode: 'parsed_custom', parserConnectionId: 'deleted-parser', parserModel: 'parser-model', parserParameters: { temperature: 0.2 } } : p) } }))
    await change(field(t('imageGenPanel.activeMainPreset')).querySelector('select')!, 'main-preset')
    expect(state.imageGeneration).toMatchObject({ activePromptPresetId: 'main-preset', promptMode: 'parsed_custom', customPrompt: 'Main prompt', customNegativePrompt: 'main-preset-negative', promptParserConnectionId: 'shared', promptParserModel: 'shared-model', promptParserParameters: { temperature: 0.7 } })
  })
  test('prompt drafts debounce, survive close/reopen, and flush before generation', async () => {
    await render(); await openPrompt()
    await change(host.querySelector('textarea')!, 'Live draft')
    expect(setImageGenSettings).not.toHaveBeenCalled()
    await click('Done'); await openPrompt(); expect(host.querySelector('textarea')!.value).toBe('Live draft')
    await act(async () => { jest.advanceTimersByTime(499) }); expect(setImageGenSettings).not.toHaveBeenCalled()
    await act(async () => { jest.advanceTimersByTime(1) }); expect(state.imageGeneration.customPrompt).toBe('Live draft')
    await change(host.querySelector('textarea')!, 'Immediate draft'); await click('Done'); await click(t('imageGenPanel.generateNow'))
    expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Immediate draft', forceGeneration: false }))
    await click(t('imageGenPanel.forceGenerate')); expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({ forceGeneration: true }))
  })
  test('authoring targets filter presets and preserve character/persona binding calls', async () => {
    await render(); await openPrompt(); await click('Character')
    expect(host.querySelector('textarea')!.value).toBe('Character snippet')
    const select = field(t('imageGenPanel.boundCharacterPreset')).querySelector('select')!
    expect([...select.options].map(option => option.value)).toEqual(['', 'character-preset'])
    await change(select, ''); expect(bindings.deleteCharacterBinding).toHaveBeenCalledWith('character')
    await change(select, 'character-preset'); expect(setCharacterBinding).toHaveBeenCalledWith('character', 'character-preset')
    await change(host.querySelector('textarea')!, 'Unsaved character draft'); await click('Done'); await openPrompt()
    expect(host.querySelector('textarea')!.value).toBe('Unsaved character draft')
    await click('Persona'); await change(field(t('imageGenPanel.boundPersonaPreset')).querySelector('select')!, 'persona-preset')
    expect(setPersonaBinding).toHaveBeenCalledWith('persona', 'persona-preset')
    await click('Captioning'); expect([...field(t('imageGenPanel.boundCaptioningPreset')).querySelector('select')!.options].map(option => option.value)).toEqual(['', 'captioning-preset'])
    await change(field(t('imageGenPanel.boundCaptioningPreset')).querySelector('select')!, 'captioning-preset'); expect(host.querySelector('textarea')!.value).toBe('Caption instructions')
    await change(host.querySelector('select[aria-label="Parser Connection"]')!, 'other'); expect(state.imageGeneration.promptParserConnectionId).toBeUndefined()
    await change(host.querySelector('[aria-label="' + t('imageGenPanel.parserTemperature') + '"]')!, '0.6')
    await change(host.querySelector('[aria-label="' + t('imageGenPanel.parserTopP') + '"]')!, '0.8')
    await change(field(t('imageGenPanel.parserMaxTokens')).querySelector('input')!, '128')
    await click(t('imageGenPanel.saveChanges'))
    const caption = state.imageGeneration.promptPresets.find((entry: any) => entry.id === 'captioning-preset')
    expect(caption).toMatchObject({ parserConnectionId: 'other', parserParameters: { temperature: 0.6, top_p: 0.8, max_tokens: 128 } })
    expect(state.imageGeneration.promptParserParameters).toBeUndefined()
    expect(host.querySelector('textarea')!.value).toBe('Caption instructions')
    await click('Parser')
    expect(host.querySelectorAll('textarea').length).toBe(0)
    await change(host.querySelector('select[aria-label="Parser Connection"]')!, 'connection')
    expect(state.imageGeneration.promptParserConnectionId).toBe('connection')
    await click('Main')
    expect(host.querySelector('select[aria-label="Parser Connection"]')).toBeNull()
    await click('Character')
    expect(host.querySelector('select[aria-label="Parser Connection"]')).toBeNull()
    await click('Persona')
    expect(host.querySelector('select[aria-label="Parser Connection"]')).toBeNull()
  })
  test('preset save updates or creates, and delete requires confirmation', async () => {
    await render(); await openPrompt()
    await change(field(t('imageGenPanel.activeMainPreset')).querySelector('select')!, 'main-preset')
    await change(host.querySelector('textarea')!, 'Updated main'); await click(t('imageGenPanel.saveChanges'))
    expect(state.imageGeneration.promptPresets.find((p: any) => p.id === 'main-preset').prompt).toBe('Updated main')
    await change(field('Preset name').querySelector('input')!, 'Copy'); await click(t('imageGenPanel.saveAsNew'))
    const copy = state.imageGeneration.promptPresets.find((p: any) => p.name === 'Copy'); expect(copy.id).not.toBe('main-preset'); expect(copy.prompt).toBe('Updated main')
    await click(t('imageGenPanel.delete')); expect(state.imageGeneration.promptPresets).toContainEqual(copy)
    expect(button('Done').disabled).toBe(true)
    await click('Cancel delete'); expect(button('Done').disabled).toBe(false)
    await click(t('imageGenPanel.delete'))
    await click('Confirm delete'); expect(state.imageGeneration.promptPresets).not.toContainEqual(copy)
  })
  test('LoRA drafts survive closure; save, bypass, scale, delete, and runtime selection use existing fields', async () => {
    await render(); await openLora(); expect(host.querySelector<HTMLInputElement>('[aria-label="LoRA filename"]')!.value).toBe('ink.safetensors')
    await change(host.querySelector('[aria-label="LoRA filename"]')!, 'new.safetensors')
    await change(host.querySelector('textarea')!, 'new base tags'); await click('Done'); await openLora()
    expect(host.querySelector<HTMLInputElement>('[aria-label="LoRA filename"]')!.value).toBe('new.safetensors')
    await click(t('imageGenPanel.addLora')); expect(host.querySelectorAll('[aria-label="LoRA filename"]').length).toBe(2)
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent === 'Remove LoRA')[1].click())
    await click(t('imageGenPanel.saveLoraPreset')); expect(state.imageGeneration.loraPresets[0]).toMatchObject({ base_tags: 'new base tags', loras: [{ lora_name: 'new.safetensors', weight_model: 0.8 }] })
    const bypass = [...host.querySelectorAll('label')].find(node => node.textContent === t('imageGenPanel.bypassActiveLoraPreset'))!
    await act(async () => bypass.querySelector<HTMLInputElement>('input')!.click()); expect(state.imageGeneration.bypassActiveLoraPreset).toBe(true)
    await change(host.querySelector('[aria-label="' + t('imageGenPanel.loraStrengthScale') + '"]')!, '0.5'); expect(state.imageGeneration.loraStrengthScale).toBe(0.5)
    await click(t('imageGenPanel.deleteLoraPreset')); expect(state.imageGeneration.loraPresets.length).toBe(1)
    await click('Confirm delete'); expect(state.imageGeneration.loraPresets).toEqual([])
    await click('Done'); await change(field(t('imageGenPanel.activeLoraPreset')).querySelector('select')!, ''); expect(state.imageGeneration.activeLoraPresetId).toBeNull()
  })
  test('settings route schema groups, persist to connection, retain unknown fields, and adapt to provider changes', async () => {
    await render(); await click('Configure Generation…')
    expect(field('Width')).toBeDefined(); expect(field('Vae')).toBeDefined(); expect(field('Provider Negative Prompt')).toBeDefined()
    const overrides = host.querySelector<HTMLDetailsElement>('details')!
    expect(overrides.querySelector('summary')!.textContent).toBe('Model Overrides')
    expect(overrides.open).toBe(false)
    await act(async () => overrides.querySelector('summary')!.click())
    expect(overrides.open).toBe(true)
    expect(host.textContent).not.toContain('Future Knob')
    await change(field('Width').querySelector('input')!, '768')
    expect(updateConnection).toHaveBeenLastCalledWith('connection', { default_parameters: { width: 768 } })
    await click('Sources'); expect(field('Init Image')).toBeDefined(); expect(field('Reference Strength')).toBeDefined()
    await click('Advanced'); expect(field('Future Knob')).toBeDefined(); expect(field('Seed')).toBeDefined()
    await change(field(t('imageGenPanel.imageGenerationTimeout')).querySelector('input')!, '420'); expect(state.imageGeneration.generationTimeoutSeconds).toBe(420)
    await click('Automation'); await change(host.querySelector('[aria-label="' + t('imageGenPanel.opacity') + '"]')!, '50'); expect(state.imageGeneration.backgroundOpacity).toBe(0.5)
    await change(field(t('imageGenPanel.contextMessageLimit')).querySelector('input')!, '9'); expect(state.imageGeneration.promptContextMessageLimit).toBe(9)
    await click('Sources'); await act(async () => patch({ activeImageGenConnectionId: 'other' }))
    expect([...host.querySelectorAll('button')].some(node => node.textContent === 'Sources')).toBe(false)
    expect(host.textContent).not.toContain('Init Image')
  })
  test('reference limit, removal, and avatar settings stay scoped to the selected connection', async () => {
    await render()
    const referenceImages = Array.from({ length: 14 }, (_, index) => ({ data: `image-${index}`, mimeType: 'image/png' }))
    await act(async () => patch({ imageGenProfiles: state.imageGenProfiles.map((profile: any) => profile.id === 'connection' ? { ...profile, provider: 'swarmui', default_parameters: { referenceImages } } : profile), imageGenProviders: [{ id: 'swarmui', capabilities: { parameters: {} } }] }))
    await click('Configure Generation…'); await click('Sources')
    expect([...host.querySelectorAll('button')].some(node => node.textContent === t('imageGenPanel.addReference'))).toBe(false)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label$="— remove"]')!.click())
    expect(updateConnection).toHaveBeenLastCalledWith('connection', { default_parameters: { referenceImages: referenceImages.slice(1) } })
    expect(button(t('imageGenPanel.addReference'))).toBeDefined()
    const avatar = [...host.querySelectorAll('label')].find(node => node.textContent === t('imageGenPanel.includeCharacterAvatar'))!
    await act(async () => avatar.querySelector<HTMLInputElement>('input')!.click())
    expect(state.imageGenProfiles[0].default_parameters.includeCharacterAvatar).toBe(true)
  })
  test('runtime LoRA preset selection hydrates the studio with the selected stack', async () => {
    await render()
    await act(async () => setImageGenSettings({ loraPresets: [...state.imageGeneration.loraPresets, { id: 'second-lora', name: 'Second', loras: [{ lora_name: 'second.safetensors', weight_model: 1 }], base_tags: 'second tags' }] }))
    await change(field(t('imageGenPanel.activeLoraPreset')).querySelector('select')!, 'second-lora')
    expect(state.imageGeneration.activeLoraPresetId).toBe('second-lora')
    await openLora(); expect(host.querySelector<HTMLInputElement>('[aria-label="LoRA filename"]')!.value).toBe('second.safetensors')
    expect(host.querySelector('textarea')!.value).toBe('second tags')
  })
  test('Comfy workflow controls tolerate an unconfigured workflow after switching providers', async () => {
    await render(); await act(async () => patch({ imageGenProfiles: state.imageGenProfiles.map((p: any) => p.id === 'connection' ? { ...p, provider: 'comfyui' } : p), imageGenProviders: [{ id: 'comfyui', capabilities: { parameters: {} } }] }))
    await click('Configure Generation…'); expect(button(t('imageGenPanel.importWorkflow'))).toBeDefined()
    await click(t('imageGenPanel.importWorkflow')); expect(host.textContent).toContain('Workflow editor')
    expect(button('Done').disabled).toBe(true)
  })
})
