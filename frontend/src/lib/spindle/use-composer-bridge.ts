import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { notifyComposerChanged, registerComposer } from './composer-api'

interface ComposerBridgeOptions {
  chatId: string
  text: string
  setText(text: string): void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  handleSend(): Promise<void>
  isGeneratingInChat: boolean
  sendingRef: RefObject<boolean>
}

/** Connects the mounted InputArea draft and send path to ctx.composer. */
export function useComposerBridge({
  chatId, text, setText, textareaRef, handleSend, isGeneratingInChat, sendingRef,
}: ComposerBridgeOptions): void {
  const latestRef = useRef({ chatId, text, setText, textareaRef, handleSend, busy: isGeneratingInChat, sendingRef })
  useLayoutEffect(() => {
    latestRef.current = { chatId, text, setText, textareaRef, handleSend, busy: isGeneratingInChat, sendingRef }
  })
  useEffect(() => registerComposer({
    getChatId: () => latestRef.current.chatId,
    getText: () => latestRef.current.text,
    setText: (next) => flushSync(() => latestRef.current.setText(next)),
    insertText: (value, at) => {
      const current = latestRef.current.text
      const ta = at === 'caret' ? latestRef.current.textareaRef.current : null
      const start = ta ? ta.selectionStart : current.length
      const end = ta ? ta.selectionEnd : current.length
      flushSync(() => latestRef.current.setText(current.slice(0, start) + value + current.slice(end)))
      ta?.setSelectionRange(start + value.length, start + value.length)
    },
    focus: () => latestRef.current.textareaRef.current?.focus(),
    send: async () => {
      const latest = latestRef.current
      if (latest.busy || latest.sendingRef.current) {
        throw new Error('COMPOSER_BUSY: A message is already being sent or generated in this chat')
      }
      await latest.handleSend()
    },
  }), [])
  useEffect(() => {
    notifyComposerChanged()
  }, [chatId, text])
}
