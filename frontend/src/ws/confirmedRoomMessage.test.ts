import { beforeEach, expect, mock, test } from 'bun:test'
import { EventType } from '@/types/ws-events'

const handlers = new Map<string, Set<(payload: any) => void>>()
const sendRoomAction = mock((_action: unknown) => {})
mock.module('./relayClient', () => ({ sendRoomAction }))
mock.module('./client', () => ({ wsClient: {
  on(event: string, handler: (payload: any) => void) {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event)!.add(handler)
    return () => { handlers.get(event)!.delete(handler) }
  },
} }))
const { sendConfirmedRoomMessage } = await import('./confirmedRoomMessage')
const input = { chatId: 'chat', participantId: 'peer', content: ' my message ', associativeRegexAppend: [] }
const confirmation = {
  chatId: 'chat',
  message: { is_user: true, content: 'my message', extra: { mp: { participantId: 'peer' } } },
}
const emit = (event: string, payload: unknown) => { for (const handler of handlers.get(event) || []) handler(payload) }
const listenerCount = () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0)
beforeEach(() => { handlers.clear(); sendRoomAction.mockReset() })

test('room sends wait for a saved message matching the chat, author and content', async () => {
  let confirmed = false
  const pending = sendConfirmedRoomMessage(input).then(() => { confirmed = true })
  expect(sendRoomAction).toHaveBeenCalledTimes(1)
  emit(EventType.MESSAGE_SENT, { ...confirmation, chatId: 'other' })
  emit(EventType.MESSAGE_SENT, { ...confirmation, message: { ...confirmation.message, content: 'other text' } })
  emit(EventType.MESSAGE_SENT, { ...confirmation, message: { ...confirmation.message, extra: { mp: { participantId: 'someone-else' } } } })
  await Promise.resolve()
  expect(confirmed).toBe(false)
  emit(EventType.MESSAGE_SENT, confirmation)
  await pending
  expect(confirmed).toBe(true)
  expect(listenerCount()).toBe(0)
})

test('a host rejection fails the send and releases listeners', async () => {
  const pending = sendConfirmedRoomMessage(input)
  emit('ROOM_MESSAGE_REJECTED', { reason: 'not_your_turn' })
  await expect(pending).rejects.toThrow('room_message_rejected')
  expect(listenerCount()).toBe(0)
})

test('a dropped or disconnected submission times out without retrying', async () => {
  await expect(sendConfirmedRoomMessage(input, 5)).rejects.toThrow('room_message_unconfirmed')
  expect(sendRoomAction).toHaveBeenCalledTimes(1)
  expect(listenerCount()).toBe(0)
})

test('a socket send exception fails the send and releases listeners', async () => {
  sendRoomAction.mockImplementation(() => { throw new Error('socket closed') })
  await expect(sendConfirmedRoomMessage(input)).rejects.toThrow('socket closed')
  expect(listenerCount()).toBe(0)
})
