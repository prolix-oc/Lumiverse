import { describe, expect, test } from 'bun:test'
import type {
  Chat,
  ChatSummary,
  ConnectionProfile,
  GroupedRecentChat,
  Message,
  PaginatedResult,
  RecentChat,
  WorldBook,
  WorldBookEntry,
} from '@/types/api'
import type { AppStore } from '@/types/store'
import { createFrontendExtensionContext } from './frontend-context'
import {
  createFrontendDomainApi,
  MAX_TOKEN_MESSAGES,
  type FrontendDomainDependencies,
  type FrontendStore,
} from './frontend-domain-api'

const profile = (): ConnectionProfile & { api_key: string } => ({
  id: 'profile-1',
  name: 'Main',
  provider: 'openai',
  api_url: '',
  model: 'gpt-test',
  preset_id: null,
  is_default: true,
  has_api_key: true,
  metadata: { label: 'safe' },
  created_at: 1,
  updated_at: 1,
  review_required: false,
  review_code: null,
  api_key: 'secret-must-not-escape',
})

const message = (id: string, content: string): Message => ({
  id,
  chat_id: 'chat-1',
  index_in_chat: 0,
  is_user: false,
  name: 'Assistant',
  content,
  send_date: 1,
  swipe_id: 0,
  swipes: [content],
  swipe_dates: [1],
  extra: {},
  parent_message_id: null,
  branch_id: null,
  created_at: 1,
})

function createHarness() {
  let state = {
    profiles: [
      profile(),
      { ...profile(), id: 'profile-2', name: 'Secondary', model: 'gpt-test-2' },
    ],
    activeProfileId: 'profile-1',
    messages: [message('message-1', 'hello')],
    setActiveProfile(id: string | null) {
      state = { ...state, activeProfileId: id }
      for (const listener of [...listeners]) listener(state as unknown as AppStore)
    },
    updateProfile(id: string, updates: Partial<ConnectionProfile>) {
      state = {
        ...state,
        profiles: state.profiles.map((item) => item.id === id ? { ...item, ...updates } : item),
      }
      for (const listener of [...listeners]) listener(state as unknown as AppStore)
    },
  }
  const listeners = new Set<(state: AppStore, previous?: AppStore) => void>()
  const store: FrontendStore = {
    getState: () => state as unknown as AppStore,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const calls: string[] = []
  const teardown: Array<() => void> = []
  let active = true
  const chats: ChatSummary[] = [{
    id: 'chat-1',
    name: 'Chat',
    message_count: 1,
    created_at: 1,
    updated_at: 1,
    last_message_preview: 'hello',
  }]
  const page: PaginatedResult<Message> = { data: [message('message-2', 'api')], total: 1, limit: 2, offset: 0 }
  const books: WorldBook[] = [{
    id: 'book-1',
    name: 'Book',
    description: 'Description',
    folder: '',
    metadata: {},
    created_at: 1,
    updated_at: 1,
  }]
  const entries: WorldBookEntry[] = []
  const recentChats: RecentChat[] = [{
    id: 'chat-1',
    character_id: 'character-1',
    name: 'Chat',
    metadata: {},
    created_at: 1,
    updated_at: 2,
    character_name: 'Character',
    character_avatar_path: null,
    character_image_id: null,
    message_count: 3,
    last_message_preview: 'latest',
  }]
  const groupedChats: GroupedRecentChat[] = [{
    character_id: 'character-1',
    character_name: 'Character',
    character_avatar_path: null,
    character_image_id: null,
    latest_chat_id: 'chat-1',
    latest_chat_name: 'Chat',
    updated_at: 2,
    chat_count: 1,
    is_group: false,
  }]
  let nextUpdate: Chat = { id: 'chat-1', name: 'Renamed' } as Chat
  const dependencies: FrontendDomainDependencies = {
    store,
    assertActive: () => {
      if (!active) throw new Error('STALE_GENERATION')
    },
    requirePermission(permission, member) {
      calls.push(`permission:${permission}:${member}`)
      if (permission === 'generation') throw new Error('PERMISSION_DENIED:generation')
    },
    onTeardown(handler) {
      teardown.push(handler)
      return () => {
        const index = teardown.indexOf(handler)
        if (index !== -1) teardown.splice(index, 1)
      }
    },
    connections: {
      async models(id) {
        calls.push(`models:${id}`)
        return { models: ['gpt-test'], provider: 'openai' }
      },
      async update(id, input) {
        calls.push(`update:${id}:${String(input.name ?? '')}`)
        return { ...profile(), ...input }
      },
    },
    chats: {
      async listForCharacter(characterId) {
        calls.push(`character-chats:${characterId}`)
        return chats
      },
      async getMessages(chatId, options) {
        calls.push(`messages:${chatId}:${String(options?.limit)}`)
        return page
      },
      async listRecent(options) {
        calls.push(`recent:${JSON.stringify(options)}`)
        return { data: recentChats, total: recentChats.length, limit: options?.limit ?? 0, offset: options?.offset ?? 0 }
      },
      async listRecentGrouped(options) {
        calls.push(`recent-grouped:${JSON.stringify(options)}`)
        return { data: groupedChats, total: groupedChats.length, limit: options?.limit ?? 0, offset: options?.offset ?? 0 }
      },
      async update(chatId, input) {
        calls.push(`chat-update:${chatId}:${String(input.name ?? '')}`)
        return nextUpdate
      },
      async delete(chatId) {
        calls.push(`chat-delete:${chatId}`)
      },
    },
    worldBooks: {
      async list() {
        calls.push('world-books:list')
        return books
      },
      async entries(bookId) {
        calls.push(`world-books:entries:${bookId}`)
        return entries
      },
    },
    tokens: {
      async countText(text) {
        calls.push(`tokens:text:${text}`)
        if (text === '') return { total_tokens: 2 }
        if (text === 'assistant\napi') return { total_tokens: 3 }
        return { total_tokens: 1 }
      },
      async countTextBatch(texts) { calls.push(`tokens:batch:${texts.length}`); return { total_tokens: 4 } },
    },
  }
  return { dependencies, store, calls, teardown, setActive(value: boolean) { active = value }, state: () => state }
}

describe('H10 domain API bridge', () => {
  test('keeps free reads cloned, capped, and free of userId parameters', async () => {
    const harness = createHarness()
    const domain = createFrontendDomainApi(harness.dependencies)

    const profiles = domain.connections.list()
    profiles[0]!.metadata.label = 'caller mutation'
    expect(harness.state().profiles[0]!.metadata.label).toBe('safe')
    expect(profiles[0]).not.toHaveProperty('api_key')

    const active = domain.connections.getActive()
    expect(active).toEqual({ activeProfileId: 'profile-1', provider: 'openai', model: 'gpt-test' })
    expect(domain.messages.getContent('message-1')).toBe('hello')
    expect(domain.messages.getRecent(500)).toHaveLength(1)
    expect(await domain.chats.listForCharacter('character-1')).toEqual(await harness.dependencies.chats.listForCharacter('character-1'))
    expect((await domain.chats.getMessages('chat-1', { limit: 500, tail: true })).data).toHaveLength(1)
    expect(await domain.worldBooks.list({ fields: ['id', 'name'] })).toEqual([{ id: 'book-1', name: 'Book' }])
    expect(await domain.worldBooks.entries('book-1')).toEqual([])
    expect(await domain.tokens.countText('hello')).toEqual({ total_tokens: 1 })
    expect(await domain.tokens.countMessages([])).toEqual({ total_tokens: 2 })
    expect(await domain.tokens.countChat('chat-1')).toEqual({ total_tokens: 3 })
    expect(await domain.tokens.countTextBatch(['a', 'b'])).toEqual({ total_tokens: 4 })
    expect(harness.calls).toContain('messages:chat-1:200')
    expect(harness.calls.some((call) => call.includes('userId'))).toBe(false)
  })

  test('recent chat reads stay free, bounded, and query-shaped', async () => {
    const harness = createHarness()
    const domain = createFrontendDomainApi(harness.dependencies)

    const flat = await domain.chats.listRecent({ limit: 500, search: 'alp', sort: 'name', direction: 'asc' })
    expect(flat.data[0]).toMatchObject({ id: 'chat-1', message_count: 3, last_message_preview: 'latest' })
    expect(harness.calls).toContain('recent:{"limit":200,"search":"alp","sort":"name","direction":"asc"}')
    expect(harness.calls.some((call) => call.startsWith('permission:chats:ctx.chats.listRecent'))).toBe(false)

    const grouped = await domain.chats.listRecentGrouped({ limit: 500, sort: 'created', direction: 'desc' })
    expect(grouped.data[0]!.latest_chat_id).toBe('chat-1')
    expect(harness.calls).toContain('recent-grouped:{"limit":200,"sort":"created","direction":"desc"}')

    const defaults = await domain.chats.listRecent()
    expect(harness.calls).toContain('recent:{"limit":50}')
    expect(defaults.total).toBe(1)
  })

  test('chat writes are gated on the chats permission and checked after awaits', async () => {
    const harness = createHarness()
    const domain = createFrontendDomainApi(harness.dependencies)

    harness.dependencies.requirePermission = (permission) => {
      if (permission === 'chats') throw new Error('PERMISSION_DENIED:chats')
    }
    await expect(domain.chats.update('chat-1', { name: 'Renamed' })).rejects.toThrow('PERMISSION_DENIED:chats')
    await expect(domain.chats.delete('chat-1')).rejects.toThrow('PERMISSION_DENIED:chats')
    expect(harness.calls).not.toContain('chat-update:chat-1:Renamed')
    expect(harness.calls).not.toContain('chat-delete:chat-1')

    harness.dependencies.requirePermission = () => {}
    await expect(domain.chats.update('chat-1', { name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' })
    expect(harness.calls).toContain('chat-update:chat-1:Renamed')

    let resolveDelete!: () => void
    harness.dependencies.chats.delete = () => new Promise<void>((resolve) => { resolveDelete = resolve })
    const pending = domain.chats.delete('chat-1')
    harness.setActive(false)
    resolveDelete()
    await expect(pending).rejects.toThrow('STALE_GENERATION')
  })

  test('normalizes bounded message arrays and current chat rows before tokenizing', async () => {
    const harness = createHarness()
    const texts: string[] = []
    harness.dependencies.tokens = {
      async countText(text) {
        texts.push(text)
        return { total_tokens: text.length }
      },
      async countTextBatch() {
        return { total_tokens: 0 }
      },
    }
    harness.dependencies.chats.getMessages = async (chatId, options) => {
      expect(chatId).toBe('chat-1')
      expect(options).toEqual({ limit: MAX_TOKEN_MESSAGES, tail: true })
      return {
        data: [
          { ...message('user-message', 'user text'), is_user: true },
          { ...message('system-message', 'system text'), extra: { spindle_role: 'system' } },
        ],
        total: 2,
        limit: MAX_TOKEN_MESSAGES,
        offset: 0,
      }
    }
    const domain = createFrontendDomainApi(harness.dependencies)

    await domain.tokens.countMessages([{ role: 'user', content: 'hello' }])
    await domain.tokens.countChat('chat-1')
    expect(texts).toEqual(['user\nhello', 'user\nuser text\nsystem\nsystem text'])
    await expect(domain.tokens.countMessages([{ role: 'tool', content: 'nope' }])).rejects.toThrow('role must be system, user, or assistant')
    await expect(domain.tokens.countMessages(new Array(MAX_TOKEN_MESSAGES + 1).fill({ role: 'user', content: 'x' }))).rejects.toThrow('200-item cap')
    await expect(domain.tokens.countMessages('not-an-array' as unknown as readonly Record<string, unknown>[])).rejects.toThrow('messages must be an array')
  })

  test('checks generation after fetching chat messages before token transport', async () => {
    const harness = createHarness()
    const { promise: pendingMessages, resolve: resolveMessages } = Promise.withResolvers<PaginatedResult<Message>>()
    harness.dependencies.chats.getMessages = () => pendingMessages
    const domain = createFrontendDomainApi(harness.dependencies)
    const result = domain.tokens.countChat('chat-1')
    harness.setActive(false)
    resolveMessages({ data: [], total: 0, limit: MAX_TOKEN_MESSAGES, offset: 0 })
    await expect(result).rejects.toThrow('STALE_GENERATION')
  })

  test('fans out cloned active-connection notifications and tears them down', () => {
    const harness = createHarness()
    const domain = createFrontendDomainApi(harness.dependencies)
    const first: Array<{ activeProfileId: string | null }> = []
    const second: Array<{ activeProfileId: string | null }> = []
    const stopFirst = domain.connections.subscribe((value) => first.push(value))
    domain.connections.subscribe((value) => second.push(value))

    harness.store.getState().setActiveProfile('profile-2')
    expect(first).toHaveLength(1)
    expect(first[0]).not.toBe(second[0])
    first[0]!.activeProfileId = 'caller mutation'
    expect(second[0]!.activeProfileId).toBe('profile-2')

    domain.dispose()
    expect(() => domain.connections.getActive()).toThrow('domain bridge is disposed')
  })

  test('keeps legacy connections.setActive synchronous while setActiveAcknowledged awaits coordinator acknowledgement', async () => {
    const harness = createHarness()
    harness.dependencies.requirePermission = () => {}
    const pending = Promise.withResolvers<void>()
    harness.dependencies.connections.acknowledgeActive = () => pending.promise
    const domain = createFrontendDomainApi(harness.dependencies)

    const syncResult = domain.connections.setActive('profile-2')
    expect(syncResult).toBeUndefined()
    expect(harness.state().activeProfileId).toBe('profile-2')

    let settled = false
    const acknowledged = domain.connections.setActiveAcknowledged('profile-1', 'user_selection').then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(harness.state().activeProfileId).toBe('profile-1')
    pending.resolve()
    await acknowledged
    expect(settled).toBe(true)
  })

  test('gates generation writes and checks the generation after awaits', async () => {
    const harness = createHarness()
    const domain = createFrontendDomainApi(harness.dependencies)
    await expect(domain.connections.models('profile-1')).rejects.toThrow('PERMISSION_DENIED:generation')
    await expect(domain.connections.update('profile-1', { name: 'Updated' })).rejects.toThrow('PERMISSION_DENIED:generation')
    expect(() => domain.connections.setActive('profile-2')).toThrow('PERMISSION_DENIED:generation')

    let resolveUpdate!: (value: ConnectionProfile) => void
    const pending = new Promise<ConnectionProfile>((resolve) => { resolveUpdate = resolve })
    harness.dependencies.requirePermission = () => {}
    harness.dependencies.connections.update = () => pending
    const result = domain.connections.update('profile-1', { name: 'Updated' })
    harness.setActive(false)
    resolveUpdate({ ...profile(), name: 'Updated' })
    await expect(result).rejects.toThrow('STALE_GENERATION')
  })

  test('bounds and copies token batches, then checks generation after transport', async () => {
    const harness = createHarness()
    let received: readonly string[] = []
    harness.dependencies.tokens = {
      countText: harness.dependencies.tokens!.countText,
      async countTextBatch(texts) {
        received = texts
        return { total_tokens: texts.length }
      },
    }
    const domain = createFrontendDomainApi(harness.dependencies)
    const input = ['first', 'second']
    const result = await domain.tokens.countTextBatch(input)
    input[0] = 'caller mutation'

    expect(result).toEqual({ total_tokens: 2 })
    expect(received).toEqual(['first', 'second'])
    await expect(domain.tokens.countTextBatch(new Array(65).fill('x'))).rejects.toThrow('64-item cap')
    await expect(domain.tokens.countTextBatch(['ok', 42 as unknown as string])).rejects.toThrow('texts[1] must be a string')
  })

  test('fails closed when the real host token transport is unavailable', async () => {
    const harness = createHarness()
    const unavailable = createFrontendDomainApi({
      ...harness.dependencies,
      tokens: undefined,
    })

    await expect(unavailable.tokens.countText('hello')).rejects.toThrow('H14_TOKEN_API_NOT_INTEGRATED')
    await expect(unavailable.tokens.countTextBatch(['hello'])).rejects.toThrow('H14_TOKEN_API_NOT_INTEGRATED')
  })

  test('rejects a stale-generation batch transport response', async () => {
    const harness = createHarness()
    const pendingBatch = Promise.withResolvers<unknown>()
    harness.dependencies.tokens = {
      countText: harness.dependencies.tokens!.countText,
      countTextBatch: () => pendingBatch.promise,
    }
    const domain = createFrontendDomainApi(harness.dependencies)
    const result = domain.tokens.countTextBatch(['hello'])
    harness.setActive(false)
    pendingBatch.resolve({ total_tokens: 1 })

    await expect(result).rejects.toThrow('STALE_GENERATION')
  })

  test('factory preserves existing context members while exposing every bridge root', () => {
    const harness = createHarness()
    const domain = createFrontendDomainApi(harness.dependencies)
    const base = {
      marker: 'host',
      chats: { updateMessage: () => 'existing' },
      messages: { listMessageIds: () => ['message-1'] },
    }
    const state = { get: () => null, subscribe: () => () => {}, list: () => [], revokePermissions: () => {}, dispose: () => {} }
    const context = createFrontendExtensionContext({
      base,
      state,
      domain,
      onTeardown: () => () => {},
    })
    expect(context.marker).toBe('host')
    expect(context.chats.updateMessage()).toBe('existing')
    expect(context.chats.listForCharacter).toBe(domain.chats.listForCharacter)
    expect(context.messages.listMessageIds()).toEqual(['message-1'])
    expect(context.messages.getContent('message-1')).toBe('hello')
    expect(context.state).toBe(state)
    expect(context.worldBooks).toBe(domain.worldBooks)
    expect(context.tokens).toBe(domain.tokens)
    for (const handler of [...harness.teardown]) handler()
  })
})
