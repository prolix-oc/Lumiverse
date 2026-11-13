import { describe, expect, mock, test } from 'bun:test'
import { navigateFromNotification } from './notificationNavigation'

describe('notification navigation', () => {
  test.each([
    ['https://lumiverse.test/chat/chat-1', '/chat/chat-1'],
    ['https://lumiverse.test/chat/chat-1?panel=details#message-2', '/chat/chat-1'],
    ['https://lumiverse.test/chat/chat-1/', '/#/chat/chat-1'],
  ])('preserves the displayed chat at %s when opening %s', (current, target) => {
    const navigate = mock(() => {})
    navigateFromNotification(current, target, navigate)
    expect(navigate).not.toHaveBeenCalled()
  })

  test.each([
    ['https://lumiverse.test/chat/chat-1', '/chat/chat-2', '/chat/chat-2'],
    ['https://lumiverse.test/', '/chat/chat-1', '/chat/chat-1'],
    ['https://lumiverse.test/chat/chat-1', '/chat/chat-1?message=2', '/chat/chat-1?message=2'],
    ['https://lumiverse.test/chat/chat-1', '/chat/chat-1#message-2', '/chat/chat-1#message-2'],
    ['https://lumiverse.test/chat/chat-1', 'https://external.test/chat/chat-1', '/'],
  ])('navigates from %s to %s when required', (current, target, expected) => {
    const navigate = mock(() => {})
    navigateFromNotification(current, target, navigate)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(expected)
  })
})
