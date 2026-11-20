import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, useEffect, useRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createFrontendComposerAPI } from './composer-api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { createRoot } = await import('react-dom/client')
const { useComposerBridge } = await import('./use-composer-bridge')

let root: Root | undefined
const teardowns: Array<() => void> = []
const composer = createFrontendComposerAPI({
  assertActive() {},
  requirePermission() {},
  onTeardown(handler) { teardowns.push(handler); return () => {} },
})
const send = mock((_chatId: string, _text: string) => Promise.resolve())
const sendingRef = { current: false }

function Composer({ chatId = 'chat-1', generating = false, transcript }: {
  chatId?: string
  generating?: boolean
  transcript?: string
}) {
  const [text, setText] = useState('Hello')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useComposerBridge({
    chatId, text, setText, textareaRef, sendingRef,
    isGeneratingInChat: generating,
    handleSend: () => send(chatId, text),
  })
  useEffect(() => {
    if (transcript === undefined) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      composer.setText(transcript)
      void composer.send()
    })
    return () => { active = false }
  }, [transcript])
  return <textarea ref={textareaRef} value={text} onChange={(event) => setText(event.target.value)} />
}

async function mount(props: Parameters<typeof Composer>[0] = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Composer {...props} />) })
  return host.querySelector('textarea')!
}

afterEach(async () => {
  if (root) await act(() => root!.unmount())
  root = undefined
  for (const teardown of teardowns) teardown()
  document.body.replaceChildren()
  send.mockClear()
  sendingRef.current = false
})

describe('mounted composer bridge', () => {
  test('writes are immediately readable and send uses the latest draft and chat', async () => {
    const textarea = await mount()
    await act(async () => {
      composer.setText('Replaced')
      expect(textarea.value).toBe('Replaced')
      expect(composer.getState().text).toBe('Replaced')
      await composer.send()
    })
    expect(send).toHaveBeenLastCalledWith('chat-1', 'Replaced')
    await act(async () => { root!.render(<Composer chatId="chat-2" />) })
    await composer.send()
    expect(send).toHaveBeenLastCalledWith('chat-2', 'Replaced')
    expect(composer.getState().chatId).toBe('chat-2')
  })

  test('caret insertion replaces the selection and keeps focus and the new caret', async () => {
    const textarea = await mount()
    textarea.focus()
    textarea.setSelectionRange(1, 4)
    act(() => composer.insertText('ey'))
    expect(textarea.value).toBe('Heyo')
    expect(textarea.selectionStart).toBe(3)
    expect(textarea.selectionEnd).toBe(3)
    expect(document.activeElement).toBe(textarea)
  })

  test('insertion uses the blurred selection without stealing focus, and end appends', async () => {
    const textarea = await mount()
    textarea.setSelectionRange(2, 2)
    act(() => composer.insertText('XY'))
    expect(textarea.value).toBe('HeXYllo')
    expect(textarea.selectionStart).toBe(4)
    expect(document.activeElement).not.toBe(textarea)
    act(() => composer.insertText(' end', { at: 'end' }))
    expect(textarea.value).toBe('HeXYllo end')
    composer.focus()
    expect(document.activeElement).toBe(textarea)
  })

  test('generation and in-flight sends reject without changing the draft', async () => {
    await mount({ generating: true })
    await expect(composer.send()).rejects.toThrow('COMPOSER_BUSY')
    await act(async () => { root!.render(<Composer />) })
    sendingRef.current = true
    await expect(composer.send()).rejects.toThrow('COMPOSER_BUSY')
    expect(send).not.toHaveBeenCalled()
    expect(composer.getState().text).toBe('Hello')
  })

  test('microtask writes from a React effect are visible to an immediate send', async () => {
    const textarea = await mount({ transcript: 'Dictated text' })
    expect(textarea.value).toBe('Dictated text')
    expect(send).toHaveBeenLastCalledWith('chat-1', 'Dictated text')
  })

  test('onChange can write back and unmount makes the bridge unavailable', async () => {
    await mount()
    const seen: string[] = []
    composer.onChange((state) => {
      if (state.text === 'draft') composer.insertText(' end', { at: 'end' })
      seen.push(state.text)
    })
    await act(async () => { composer.setText('draft') })
    expect(seen).toEqual(['draft', 'draft end'])
    await act(() => root!.unmount())
    root = undefined
    expect(composer.getState()).toEqual({ mounted: false, chatId: null, text: '' })
    expect(() => composer.setText('x')).toThrow('COMPOSER_UNAVAILABLE')
    await expect(composer.send()).rejects.toThrow('COMPOSER_UNAVAILABLE')
  })
})
