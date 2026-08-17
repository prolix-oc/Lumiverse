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
mock.module('@/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
}))
mock.module('@/lib/spindle/productivity-feature-toggles', () => ({
  readProductivityFlag: () => true,
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
}): Promise<HTMLDivElement> {
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
    }))
    await Promise.resolve()
    await Promise.resolve()
  })
  return host
}

describe('MessageEditArea edit-and-send', () => {
  afterEach(async () => {
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

    const button = host.querySelector('button[aria-label="Edit and Send"]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('Edit and Send')
    expect(button?.disabled).toBe(false)
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

  test('Cancel does not send and stays available while pending', async () => {
    const onCancel = mock(() => {})
    const onEditAndSend = mock(() => {})
    const host = await render({
      onCancel,
      onEditAndSend,
      editAndSendDisabled: true,
    })
    const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('actions.cancel'))
    const send = host.querySelector('button[aria-label="Edit and Send"]') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await act(async () => {
      cancel?.click()
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onEditAndSend).not.toHaveBeenCalled()
  })
})
