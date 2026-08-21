/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { reconcileMessageTail } from './messageTailReconciliation'
import type { Message } from '@/types/api'

function message(index: number, content = `message-${index}`): Message {
  return {
    id: `m-${index}`,
    chat_id: 'chat-1',
    index_in_chat: index,
    is_user: index % 2 === 0,
    name: '',
    content,
    send_date: index,
    swipe_id: 0,
    swipes: [content],
    swipe_dates: [index],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: index,
  }
}

describe('reconcileMessageTail', () => {
  test('preserves loaded history before the refreshed tail', () => {
    const current = Array.from({ length: 100 }, (_, index) => message(index + 100))
    const fresh = Array.from({ length: 50 }, (_, index) => message(index + 150, `fresh-${index + 150}`))

    const result = reconcileMessageTail(current, 200, { data: fresh, total: 200, offset: 150 })

    expect(result).toHaveLength(100)
    expect(result[0].id).toBe('m-100')
    expect(result[49].id).toBe('m-149')
    expect(result[50].content).toBe('fresh-150')
  })

  test('uses the new offset to remove deleted messages from the overlap', () => {
    const current = Array.from({ length: 100 }, (_, index) => message(index + 100))
    const fresh = Array.from({ length: 50 }, (_, index) => message(index + 149))

    const result = reconcileMessageTail(current, 200, { data: fresh, total: 199, offset: 149 })

    expect(result).toHaveLength(99)
    expect(result[48].id).toBe('m-148')
    expect(result[49].id).toBe('m-149')
  })

  test('discards local streaming placeholders during authoritative reconciliation', () => {
    const placeholder = { ...message(200), id: '__stream_placeholder_1' }
    const current = [...Array.from({ length: 50 }, (_, index) => message(index + 150)), placeholder]
    const fresh = Array.from({ length: 50 }, (_, index) => message(index + 151))

    const result = reconcileMessageTail(current, 200, { data: fresh, total: 201, offset: 151 })

    expect(result.some((entry) => entry.id === placeholder.id)).toBe(false)
    expect(result[0].id).toBe('m-150')
    expect(result.at(-1)?.id).toBe('m-200')
  })

  test('replaces the whole list when the tail begins before the loaded window', () => {
    const current = Array.from({ length: 20 }, (_, index) => message(index + 80))
    const fresh = Array.from({ length: 50 }, (_, index) => message(index + 40))

    const result = reconcileMessageTail(current, 100, { data: fresh, total: 90, offset: 40 })

    expect(result.map((entry) => entry.id)).toEqual(fresh.map((entry) => entry.id))
  })
})
