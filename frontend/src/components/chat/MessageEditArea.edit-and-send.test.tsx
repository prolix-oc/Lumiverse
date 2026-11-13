import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ children }: { children?: unknown }) => children ?? null,
}))
mock.module('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

mock.module('@/components/shared/ExpandedTextEditor', () => ({
  default: () => null,
  ExpandableTextarea: () => null,
}))
let mockQuickToolbarSettings: { editAndSendSide?: string } | undefined
let mockSuiteEnabled = true

mock.module('@/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    extensions: mockSuiteEnabled
      ? [{ identifier: 'lumiverse_suite', enabled: true, has_frontend: true }]
      : [],
    quickToolbarSettings: mockQuickToolbarSettings,
  }),
}))
mock.module('@/lib/spindle/productivity-feature-toggles', () => ({
  readProductivityFlag: () => true,
  readProductivityFeature: () => true,
}))
mock.module('@/lib/spindle/use-spindle-component-override', () => ({
  useSpindleComponentOverride: (_name: string, Component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) =>
    createElement(Component as never, props as never),
}))
mock.module('./MessageEditArea.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['HTMLElement', globalObject.HTMLElement],
  ['Element', globalObject.Element],
  ['Node', globalObject.Node],
  ['SVGElement', globalObject.SVGElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
dom.window.requestAnimationFrame = (cb: FrameRequestCallback) => {
  cb(0)
  return 0
}
dom.window.cancelAnimationFrame = () => {}
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  navigator: Object.assign(dom.window.navigator, { maxTouchPoints: 0 }),
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  SVGElement: dom.window.SVGElement,
  requestAnimationFrame: dom.window.requestAnimationFrame,
  cancelAnimationFrame: dom.window.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { default: MessageEditArea } = await import('./MessageEditArea')
const { createRoot } = await import('react-dom/client')

const mountedRoots = new Set<Root>()

async function render(props: {
  editContent?: string
  onEditAndSend?: () => void
  onSave?: () => void
  onCancel?: () => void
  messageId?: string
  editAndSendDisabled?: boolean
  editAndSendSide?: string
  suiteEnabled?: boolean
  editReasoning?: string
  onChangeReasoning?: (value: string) => void
}): Promise<HTMLDivElement> {
  mockSuiteEnabled = props.suiteEnabled !== false
  mockQuickToolbarSettings = props.editAndSendSide === undefined
    ? undefined
    : { editAndSendSide: props.editAndSendSide }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(createElement(MessageEditArea, {
      editContent: props.editContent ?? 'hello',
      onChangeContent: () => {},
      onSave: props.onSave ?? (() => {}),
      onCancel: props.onCancel ?? (() => {}),
      onEditAndSend: props.onEditAndSend,
      messageId: props.messageId,
      editAndSendDisabled: props.editAndSendDisabled,
      editReasoning: props.editReasoning,
      onChangeReasoning: props.onChangeReasoning,
    }))
    await Promise.resolve()
    await Promise.resolve()
  })
  return host
}

describe('MessageEditArea edit-and-send', () => {
  afterEach(async () => {
    mockQuickToolbarSettings = undefined
    mockSuiteEnabled = true
    for (const root of [...mountedRoots]) {
      await act(async () => { root.unmount() })
      mountedRoots.delete(root)
    }
    document.body.replaceChildren()
  })

  afterAll(() => {
    for (const [key, value] of originalGlobals) {
      if (value === undefined) delete globalObject[key]
      else globalObject[key] = value
    }
  })

  test('stamps the spindle mount and exposes an accessible Edit and Send button', async () => {
    const host = await render({ messageId: 'user-1', onEditAndSend: () => {} })
    const mount = host.querySelector('[data-spindle-mount="message_edit_actions"]')
    expect(mount).not.toBeNull()
    expect(mount?.getAttribute('data-spindle-scope-key')).toBe('message:user-1:edit-actions')
    expect(mount?.getAttribute('data-edit-and-send-side')).toBe('right')

    const button = host.querySelector('button[aria-label="Edit and Send"]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('Edit and Send')
    expect(button?.disabled).toBe(false)
  })
  test('uses explicit left placement and restores native right DOM order', async () => {
    const actionLabels = (host: HTMLElement) => [...host.querySelectorAll('[data-spindle-mount="message_edit_actions"] > button')]
      .map((button) => button.textContent?.trim())

    const leftHost = await render({ onEditAndSend: () => {}, editAndSendSide: 'left' })
    expect(leftHost.querySelector('[data-spindle-mount="message_edit_actions"]')?.getAttribute('data-edit-and-send-side')).toBe('left')
    expect(actionLabels(leftHost)).toEqual(['Edit and Send', 'actions.cancel', 'actions.save'])

    const rightHost = await render({ onEditAndSend: () => {}, editAndSendSide: 'right' })
    expect(rightHost.querySelector('[data-spindle-mount="message_edit_actions"]')?.getAttribute('data-edit-and-send-side')).toBe('right')
    expect(actionLabels(rightHost)).toEqual(['actions.cancel', 'actions.save', 'Edit and Send'])
  })

  test('resolves missing and reset-like placement values to native right', async () => {
    const missingHost = await render({ onEditAndSend: () => {} })
    expect(missingHost.querySelector('[data-spindle-mount="message_edit_actions"]')?.getAttribute('data-edit-and-send-side')).toBe('right')

    const invalidHost = await render({ onEditAndSend: () => {}, editAndSendSide: 'reset' })
    expect(invalidHost.querySelector('[data-spindle-mount="message_edit_actions"]')?.getAttribute('data-edit-and-send-side')).toBe('right')
  })

  test('marks Edit and Send separately for side-specific CSS ordering', async () => {
    const host = await render({ onEditAndSend: () => {} })
    expect(host.querySelector('[data-edit-and-send-action="true"]')).not.toBeNull()
  })

  test('clicking Edit and Send fires the handler immediately', async () => {
    const onEditAndSend = mock(() => {})
    const host = await render({ onEditAndSend })
    const button = host.querySelector('button[aria-label="Edit and Send"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    expect(onEditAndSend).toHaveBeenCalledTimes(1)
  })

  test('empty content disables Edit and Send', async () => {
    const onEditAndSend = mock(() => {})
    const host = await render({ editContent: '   ', onEditAndSend })
    const button = host.querySelector('button[aria-label="Edit and Send"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await act(async () => {
      button.click()
    })
    expect(onEditAndSend).not.toHaveBeenCalled()
  })

  test('hides Edit and Send when onEditAndSend is omitted', async () => {
    const host = await render({ messageId: 'user-1' })
    expect(host.querySelector('button[aria-label="Edit and Send"]')).toBeNull()
  })

  test('hides Edit and Send and ignores persisted left placement when Suite is disabled', async () => {
    const host = await render({ onEditAndSend: () => {}, editAndSendSide: 'left', suiteEnabled: false })
    const actions = host.querySelector('[data-spindle-mount="message_edit_actions"]')
    expect(actions?.getAttribute('data-edit-and-send-side')).toBe('right')
    expect(actions?.querySelector('button[aria-label="Edit and Send"]')).toBeNull()
    expect([...actions!.querySelectorAll('button')].map((button) => button.textContent?.trim()))
      .toEqual(['actions.cancel', 'actions.save'])
  })

  test('disables every completion action while Edit and Send is pending', async () => {
    const onCancel = mock(() => {})
    const onEditAndSend = mock(() => {})
    const onSave = mock(() => {})
    const host = await render({
      onCancel,
      onEditAndSend,
      onSave,
      editAndSendDisabled: true,
    })
    const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('actions.cancel')) as HTMLButtonElement
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('actions.save')) as HTMLButtonElement
    const send = host.querySelector('button[aria-label="Edit and Send"]') as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    expect(save.disabled).toBe(true)
    expect(send.disabled).toBe(true)
    await act(async () => {
      cancel.click()
      save.click()
      send.click()
    })
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(onEditAndSend).not.toHaveBeenCalled()
  })

  test('keeps reasoning collapsed by default and places it above message content', async () => {
    const host = await render({
      editContent: 'Visible response',
      editReasoning: 'Hidden thought process',
      onChangeReasoning: () => {},
    })
    const toggle = host.querySelector('[data-reasoning-toggle="true"]') as HTMLButtonElement

    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('textarea[name="message-edit-reasoning"]')).toBeNull()
    const content = host.querySelector('textarea[name="message-edit-content"]') as HTMLTextAreaElement | null
    expect(content).not.toBeNull()
    expect(content?.value).toBe('Visible response')
    expect(toggle.compareDocumentPosition(content!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    await act(async () => {
      toggle.click()
    })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const textareas = [...host.querySelectorAll('textarea')]
    expect(textareas.map((textarea) => textarea.getAttribute('name'))).toEqual([
      'message-edit-reasoning',
      'message-edit-content',
    ])
    expect((textareas[0] as HTMLTextAreaElement).value).toBe('Hidden thought process')
  })
})
