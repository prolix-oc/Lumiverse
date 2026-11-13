import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createFrontendComposerAPI, notifyComposerChanged, registerComposer, type ComposerController } from './composer-api'

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function fakeComposer(chatId = 'chat-1', initial = '') {
  let text = initial
  const controller: ComposerController & { sent: number } = {
    sent: 0,
    getChatId: () => chatId,
    getText: () => text,
    setText(next) { text = next; notifyComposerChanged() },
    insertText(value, at) { text = at === 'end' ? text + value : value + text; notifyComposerChanged() },
    focus: mock(() => {}),
    async send() { controller.sent += 1 },
  }
  return controller
}

function createApi(granted: string[] = []) {
  const teardowns: Array<() => void> = []
  let active = true
  const api = createFrontendComposerAPI({
    assertActive() { if (!active) throw new Error('SPINDLE_FRONTEND_INACTIVE: test') },
    requirePermission(permission, member) {
      if (!active) throw new Error('SPINDLE_FRONTEND_INACTIVE: test')
      if (!granted.includes(permission)) throw new Error(`PERMISSION_DENIED:${permission} - ${member}`)
    },
    onTeardown(handler) { teardowns.push(handler); return () => {} },
  })
  return { api, teardown() { active = false; for (const handler of teardowns) handler() } }
}

let unregister: (() => void) | null = null
afterEach(async () => {
  unregister?.()
  unregister = null
  await flush()
})

describe('ctx.composer', () => {
  test('reports an unmounted composer and refuses edits and sends', async () => {
    const { api } = createApi(['generation'])
    expect(api.getState()).toEqual({ mounted: false, chatId: null, text: '' })
    expect(() => api.setText('x')).toThrow('COMPOSER_UNAVAILABLE')
    expect(() => api.insertText('x')).toThrow('COMPOSER_UNAVAILABLE')
    expect(() => api.focus()).toThrow('COMPOSER_UNAVAILABLE')
    await expect(api.send()).rejects.toThrow('COMPOSER_UNAVAILABLE')
  })

  test('reads and writes the mounted draft', () => {
    const composer = fakeComposer('chat-7', 'Hello')
    unregister = registerComposer(composer)
    const { api } = createApi()
    expect(api.getState()).toEqual({ mounted: true, chatId: 'chat-7', text: 'Hello' })
    api.insertText(' there', { at: 'end' })
    expect(api.getState().text).toBe('Hello there')
    api.insertText('Oh, ')
    expect(api.getState().text).toBe('Oh, Hello there')
    api.setText('')
    expect(api.getState().text).toBe('')
    api.focus()
    expect(composer.focus).toHaveBeenCalledTimes(1)
    expect(() => api.setText(42 as unknown as string)).toThrow(TypeError)
    expect(() => api.insertText('x', { at: 'start' as 'end' })).toThrow(TypeError)
  })

  test('send needs generation and runs the composer send path', async () => {
    const composer = fakeComposer()
    unregister = registerComposer(composer)
    await expect(createApi().api.send()).rejects.toThrow('PERMISSION_DENIED:generation')
    expect(composer.sent).toBe(0)
    await createApi(['generation']).api.send()
    expect(composer.sent).toBe(1)
  })

  test('onChange delivers one deduplicated snapshot per burst, including unmount', async () => {
    const { api } = createApi()
    const seen: unknown[] = []
    api.onChange((state) => seen.push(state))
    const composer = fakeComposer('chat-1', 'a')
    unregister = registerComposer(composer)
    composer.setText('ab')
    composer.setText('abc')
    await flush()
    expect(seen).toEqual([{ mounted: true, chatId: 'chat-1', text: 'abc' }])
    notifyComposerChanged()
    await flush()
    expect(seen).toHaveLength(1)
    unregister()
    unregister = null
    await flush()
    expect(seen[1]).toEqual({ mounted: false, chatId: null, text: '' })
  })

  test('unsubscribe or teardown during delivery skips callbacks still queued in that burst', async () => {
    const one = createApi()
    const two = createApi()
    const third = createApi()
    const removed = mock(() => {})
    const unloaded = mock(() => {})
    let unsubscribe = () => {}
    one.api.onChange(() => {
      unsubscribe()
      third.teardown()
    })
    unsubscribe = two.api.onChange(removed)
    third.api.onChange(unloaded)
    try {
      unregister = registerComposer(fakeComposer())
      await flush()
      expect(removed).not.toHaveBeenCalled()
      expect(unloaded).not.toHaveBeenCalled()
    } finally {
      one.teardown()
      two.teardown()
      third.teardown()
    }
  })

  test('a stale unregister does not remove the newer composer', () => {
    const first = registerComposer(fakeComposer('chat-1'))
    unregister = registerComposer(fakeComposer('chat-2'))
    first()
    expect(createApi().api.getState().chatId).toBe('chat-2')
  })

  test('unsubscribe and teardown stop notifications; an unloaded frontend cannot use the API', async () => {
    const one = createApi()
    const two = createApi()
    const first = mock(() => {})
    const second = mock(() => {})
    const unsubscribe = one.api.onChange(first)
    two.api.onChange(second)
    unsubscribe()
    two.teardown()
    unregister = registerComposer(fakeComposer())
    await flush()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(() => two.api.getState()).toThrow('SPINDLE_FRONTEND_INACTIVE')
    expect(() => two.api.setText('x')).toThrow('SPINDLE_FRONTEND_INACTIVE')
  })
})
