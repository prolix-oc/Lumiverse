import { afterEach, describe, expect, test } from 'bun:test'
import {
  dispatchMessageTagIntercepts,
  registerTagInterceptor,
  stripMessageTags,
  unregisterTagInterceptorsByExtension,
} from './message-interceptors'

const extensionIds = new Set<string>()

function register(
  extensionId: string,
  options: Parameters<typeof registerTagInterceptor>[2],
): Array<Parameters<Parameters<typeof registerTagInterceptor>[3]>[0]> {
  extensionIds.add(extensionId)
  const deliveries: Array<Parameters<Parameters<typeof registerTagInterceptor>[3]>[0]> = []
  registerTagInterceptor(extensionId, extensionId, options, (payload) => deliveries.push(payload))
  return deliveries
}

afterEach(() => {
  for (const extensionId of extensionIds) unregisterTagInterceptorsByExtension(extensionId)
  extensionIds.clear()
})

describe('message tag interception', () => {
  test('preserves tag ordering, removal, attributes, and payloads', () => {
    register('alpha-extension', { tagName: 'alpha', attrs: { kind: 'keep' } })
    register('beta-extension', { tagName: 'beta', removeFromMessage: false })

    const result = stripMessageTags(
      'before <alpha kind="keep">one</alpha> <beta flag=yes>two</beta> after',
      { messageId: 'm1', chatId: 'c1', isUser: false },
    )

    expect(result.content).toBe('before  <beta flag=yes>two</beta> after')
    expect(result.intercepts.map(({ payload, interceptor }) => ({
      tagName: payload.tagName,
      attrs: payload.attrs,
      content: payload.content,
      extensionId: interceptor.extensionId,
    }))).toEqual([
      { tagName: 'alpha', attrs: { kind: 'keep' }, content: 'one', extensionId: 'alpha-extension' },
      { tagName: 'beta', attrs: { flag: 'yes' }, content: 'two', extensionId: 'beta-extension' },
    ])
  })

  test('matches tags case-insensitively and honors attribute filters', () => {
    register('filtered', { tagName: 'notice', attrs: { level: 'high' } })
    const result = stripMessageTags(
      '<NOTICE level="low">keep</NOTICE><Notice level="high">remove</Notice>',
      {},
    )
    expect(result.content).toBe('<NOTICE level="low">keep</NOTICE>')
    expect(result.intercepts).toHaveLength(1)
    expect(result.intercepts[0].payload.content).toBe('remove')
  })

  test('renders a cached pending indicator for an open streaming tag', () => {
    register('stream-extension', { tagName: 'render', removeFromMessage: true })
    const result = stripMessageTags('prefix <render mode="card">partial', {
      messageId: 'm1',
      isStreaming: true,
    })
    expect(result.content).toContain('stream-extension is processing this part of the message...')
    expect(result.content).not.toContain('partial')
    expect(result.intercepts).toHaveLength(0)
  })

  test('returns the original string when no registered tag is present', () => {
    for (let i = 0; i < 50; i += 1) register(`extension-${i}`, { tagName: `tag${i}` })
    const content = 'plain content without markup '.repeat(1_000)
    const result = stripMessageTags(content, { isStreaming: true })
    expect(result.content).toBe(content)
    expect(result.intercepts).toHaveLength(0)
  })

  test('deduplicates delivery after sharing the chat-enter poller', async () => {
    const deliveries = register('queued-extension', { tagName: 'queued' })
    const first = stripMessageTags('<queued>one</queued>', { messageId: 'm1' })
    const second = stripMessageTags('<queued>two</queued>', { messageId: 'm2' })
    const previousDocument = (globalThis as any).document
    let entering = true
    ;(globalThis as any).document = {
      body: { hasAttribute: () => entering },
    }

    try {
      const delivered = new Set<string>()
      dispatchMessageTagIntercepts(first.intercepts, delivered)
      dispatchMessageTagIntercepts(first.intercepts, delivered)
      dispatchMessageTagIntercepts(second.intercepts, delivered)
      entering = false
      await Bun.sleep(60)
      expect(deliveries.map((payload) => payload.content)).toEqual(['one', 'two'])
    } finally {
      ;(globalThis as any).document = previousDocument
    }
  })
})
