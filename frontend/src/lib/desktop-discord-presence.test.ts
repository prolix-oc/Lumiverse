import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EventType } from '@/types/ws-events'
import { subscribeDesktopDiscordPresenceRefresh } from './desktop-discord-presence'

const invoke = mock(async (_command: string, _args: unknown, _options: unknown) => undefined)
const originalInternals = (window as any).__TAURI_INTERNALS__

afterEach(() => {
  invoke.mockClear()
  if (originalInternals === undefined) delete (window as any).__TAURI_INTERNALS__
  else (window as any).__TAURI_INTERNALS__ = originalInternals
})

function events() {
  const handlers = new Map<string, (payload?: { role?: unknown }) => void>()
  return {
    handlers,
    on(event: string, handler: (payload?: { role?: unknown }) => void) {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
  }
}

describe('desktop Discord chat-switch bridge', () => {
  test('initial landing load refreshes after server authentication without a chat switch', () => {
    ;(window as any).__TAURI_INTERNALS__ = { invoke }
    const source = events()
    const unsubscribe = subscribeDesktopDiscordPresenceRefresh(source)
    const connected = source.handlers.get(EventType.CONNECTED)!

    connected()
    connected({})
    connected({ role: '' })
    expect(invoke).not.toHaveBeenCalled()

    connected({ role: 'user' })
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['discord_presence_changed'])

    // Reloads and reconnects must request a new snapshot even without any
    // navigation or character-library changes on the landing page.
    connected({})
    connected({ role: 'user' })
    expect(invoke).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(source.handlers.size).toBe(0)
  })

  test('requests a fresh snapshot when a committed switch arrives, including clearing the chat', () => {
    ;(window as any).__TAURI_INTERNALS__ = { invoke }
    const source = events()
    const unsubscribe = subscribeDesktopDiscordPresenceRefresh(source)
    const switched = source.handlers.get(EventType.CHAT_SWITCHED)!

    switched()
    switched()
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'discord_presence_changed',
      'discord_presence_changed',
    ])
    unsubscribe()
    expect(source.handlers.size).toBe(0)
  })

  test('ordinary browser sessions do not subscribe or invoke native commands', () => {
    delete (window as any).__TAURI_INTERNALS__
    const source = events()
    subscribeDesktopDiscordPresenceRefresh(source)()
    expect(source.handlers.size).toBe(0)
    expect(invoke).not.toHaveBeenCalled()
  })

  test('refreshes character counts after additions, deletions, and bulk library changes', () => {
    ;(window as any).__TAURI_INTERNALS__ = { invoke }
    const source = events()
    const unsubscribe = subscribeDesktopDiscordPresenceRefresh(source)
    for (const event of [EventType.CHARACTER_CREATED, EventType.CHARACTER_DELETED, EventType.CHARACTER_LIBRARY_CHANGED]) {
      source.handlers.get(event)!()
    }
    expect(invoke).toHaveBeenCalledTimes(3)
    unsubscribe()
    expect(source.handlers.size).toBe(0)
  })
});
