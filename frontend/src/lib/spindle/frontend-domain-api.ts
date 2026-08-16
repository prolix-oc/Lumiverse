import type {
  ChatSummary,
  ConnectionModelsResult,
  ConnectionProfile,
  Message,
  PaginatedResult,
  UpdateConnectionProfileInput,
  WorldBook,
  WorldBookEntry,
} from '@/types/api'
import type { ActiveProfileSwitchReason, AppStore } from '@/types/store'

export type { ActiveProfileSwitchReason }

export interface FrontendStore {
  getState(): AppStore
  subscribe(listener: (state: AppStore, previousState?: AppStore) => void): () => void
}

export interface ConnectionActiveState {
  activeProfileId: string | null
  provider: string | null
  model: string | null
}

export interface FrontendConnectionsAPI {
  list(): ConnectionProfile[]
  getActive(): ConnectionActiveState
  subscribe(handler: (value: ConnectionActiveState) => void): () => void
  models(id: string): Promise<ConnectionModelsResult>
  setActive(id: string | null): void
  setActiveAcknowledged(id: string | null, reason?: ActiveProfileSwitchReason): Promise<void>
  update(id: string, input: UpdateConnectionProfileInput): Promise<ConnectionProfile>
}

export interface FrontendChatsAPI {
  listForCharacter(characterId: string): Promise<ChatSummary[]>
  getMessages(
    chatId: string,
    options?: { limit?: number; tail?: boolean },
  ): Promise<PaginatedResult<Message>>
  updateMessage?(chatId: string, messageId: string, input: { content?: string }): Promise<unknown>
}

export interface FrontendWorldBooksAPI {
  list(options?: { fields?: readonly string[] }): Promise<WorldBook[] | Array<Record<string, unknown>>>
  entries(bookId: string): Promise<WorldBookEntry[]>
}

export interface FrontendMessagesAPI {
  getContent(id: string): string | null
  getRecent(limit: number): Message[]
}

export interface TokenCountOptions {
  model?: string
  modelSource?: 'main' | 'sidecar'
}

export type TokenCountMessage = Record<string, unknown>

export interface FrontendTokensAPI {
  countText(text: string, options?: TokenCountOptions): Promise<unknown>
  countMessages(messages: readonly TokenCountMessage[], options?: TokenCountOptions): Promise<unknown>
  countChat(chatId: string, options?: TokenCountOptions): Promise<unknown>
  countTextBatch(texts: readonly string[], options?: TokenCountOptions): Promise<unknown>
}

/** Transport primitives used by the domain adapter; message/chat counts are composed locally. */
export interface FrontendTokenTransport {
  countText(text: string, options?: TokenCountOptions): Promise<unknown>
  countTextBatch(texts: readonly string[], options?: TokenCountOptions): Promise<unknown>
}

export const MAX_TOKEN_BATCH_TEXTS = 64

export interface FrontendDomainAPI {
  connections: FrontendConnectionsAPI
  chats: FrontendChatsAPI
  worldBooks: FrontendWorldBooksAPI
  messages: FrontendMessagesAPI
  tokens: FrontendTokensAPI
  dispose(): void
}

export interface FrontendDomainDependencies {
  store: FrontendStore
  assertActive(): void
  requirePermission(permission: string, member: string): void
  onTeardown(handler: () => void): () => void
  connections: {
    models(id: string): Promise<ConnectionModelsResult>
    update(id: string, input: UpdateConnectionProfileInput): Promise<ConnectionProfile>
    acknowledgeActive?(request: {
      id: string | null
      reason: ActiveProfileSwitchReason
    }): Promise<void>
  }
  chats: {
    listForCharacter(characterId: string): Promise<ChatSummary[]>
    getMessages(chatId: string, options?: { limit?: number; tail?: boolean }): Promise<PaginatedResult<Message>>
  }
  worldBooks: {
    list(): Promise<WorldBook[]>
    entries(bookId: string): Promise<WorldBookEntry[]>
  }
  tokens?: FrontendTokenTransport
}

const MAX_MESSAGE_READ = 200
export const MAX_TOKEN_MESSAGES = MAX_MESSAGE_READ

function clone<T>(value: T): T {
  return structuredClone(value)
}

function safeConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  const source = profile as ConnectionProfile & { api_key?: unknown }
  const { api_key: _apiKey, ...safe } = source
  return safe as ConnectionProfile
}

function activeConnection(state: AppStore): ConnectionActiveState {
  const profile = state.profiles.find((candidate) => candidate.id === state.activeProfileId)
  return {
    activeProfileId: state.activeProfileId,
    provider: profile?.provider ?? null,
    model: profile?.model ?? null,
  }
}

function sameActive(a: ConnectionActiveState, b: ConnectionActiveState): boolean {
  return a.activeProfileId === b.activeProfileId
    && a.provider === b.provider
    && a.model === b.model
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_MESSAGE_READ
  return Math.max(0, Math.min(MAX_MESSAGE_READ, Math.floor(value)))
}

function safeRecentLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_MESSAGE_READ
  return Math.max(0, Math.min(MAX_MESSAGE_READ, Math.floor(value)))
}

type TokenRole = 'system' | 'user' | 'assistant'
type NormalizedTokenMessage = { role: TokenRole; content: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTokenRole(value: unknown): value is TokenRole {
  return value === 'system' || value === 'user' || value === 'assistant'
}

function normalizeTokenMessages(messages: readonly TokenCountMessage[]): NormalizedTokenMessage[] {
  if (!Array.isArray(messages)) throw new Error('messages must be an array')
  if (messages.length > MAX_TOKEN_MESSAGES) {
    throw new Error(`Messages exceed the ${MAX_TOKEN_MESSAGES}-item cap`)
  }
  return messages.map((message, index) => {
    if (!isRecord(message)) throw new Error(`messages[${index}] must be an object`)
    if (!isTokenRole(message.role)) {
      throw new Error(`messages[${index}].role must be system, user, or assistant`)
    }
    if (typeof message.content !== 'string') {
      throw new Error(`messages[${index}].content must be a string`)
    }
    return { role: message.role, content: message.content }
  })
}

function normalizeChatMessages(value: unknown): NormalizedTokenMessage[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('chat messages response must contain a data array')
  }
  const rows = value.data.slice(-MAX_TOKEN_MESSAGES)
  return rows.map((row, index) => {
    if (!isRecord(row)) throw new Error(`chat messages[${index}] must be an object`)
    const extra = isRecord(row.extra) ? row.extra : undefined
    const role = isTokenRole(row.role)
      ? row.role
      : row.is_user === true
        ? 'user'
        : row.is_user === false && extra?.spindle_role === 'system'
          ? 'system'
          : row.is_user === false
            ? 'assistant'
            : undefined
    if (!role) throw new Error(`chat messages[${index}].role is invalid`)
    if (typeof row.content !== 'string') {
      throw new Error(`chat messages[${index}].content must be a string`)
    }
    return { role, content: row.content }
  })
}

function flattenTokenMessages(messages: readonly NormalizedTokenMessage[]): string {
  return messages.map((message) => `${message.role}\n${message.content}`).join('\n')
}

function requireChatId(chatId: string): string {
  if (typeof chatId !== 'string' || !chatId.trim()) {
    throw new Error('chatId must be a non-empty string')
  }
  return chatId.trim()
}

function validateTokenBatch(texts: readonly string[]): string[] {
  if (!Array.isArray(texts)) throw new Error('texts must be an array')
  if (texts.length > MAX_TOKEN_BATCH_TEXTS) {
    throw new Error(`Batch exceeds the ${MAX_TOKEN_BATCH_TEXTS}-item cap`)
  }
  for (let index = 0; index < texts.length; index++) {
    if (typeof texts[index] !== 'string') {
      throw new Error(`texts[${index}] must be a string`)
    }
  }
  return [...texts]
}

function denyUnavailableTokenApi(): FrontendTokensAPI {
  const unavailable = (): Promise<never> => Promise.reject(new Error('H14_TOKEN_API_NOT_INTEGRATED'))
  return {
    countText: unavailable,
    countMessages: unavailable,
    countChat: unavailable,
    countTextBatch: unavailable,
  }
}

/**
 * Creates the H10 domain roots independently of the loader. This keeps all
 * store-copy, permission, and generation checks testable without importing
 * the UI runtime. API-backed responses intentionally remain freshly parsed
 * API values; only store-backed reads are cloned here.
 */
export function createFrontendDomainApi(
  dependencies: FrontendDomainDependencies,
): FrontendDomainAPI {
  let disposed = false
  const assertUsable = () => {
    if (disposed) throw new Error('SPINDLE_FRONTEND_INACTIVE: domain bridge is disposed')
    dependencies.assertActive()
  }
  const requirePermission = (permission: string, member: string) => {
    assertUsable()
    dependencies.requirePermission(permission, member)
  }

  const subscribers = new Set<(value: ConnectionActiveState) => void>()
  let storeUnsubscribe: (() => void) | undefined
  let lastActive = activeConnection(dependencies.store.getState())

  const stopConnectionSubscription = () => {
    storeUnsubscribe?.()
    storeUnsubscribe = undefined
  }

  const startConnectionSubscription = () => {
    if (storeUnsubscribe) return
    storeUnsubscribe = dependencies.store.subscribe((state) => {
      if (disposed || subscribers.size === 0) return
      const next = activeConnection(state)
      if (sameActive(lastActive, next)) return
      lastActive = next
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(clone(next))
        } catch {
          // A subscriber cannot break the host's store listener.
        }
      }
    })
  }

  const connections: FrontendConnectionsAPI = {
    list() {
      assertUsable()
      return clone(dependencies.store.getState().profiles.map(safeConnectionProfile))
    },

    getActive() {
      assertUsable()
      return clone(activeConnection(dependencies.store.getState()))
    },

    subscribe(handler) {
      assertUsable()
      subscribers.add(handler)
      lastActive = activeConnection(dependencies.store.getState())
      startConnectionSubscription()
      return () => {
        subscribers.delete(handler)
        if (subscribers.size === 0) stopConnectionSubscription()
      }
    },

    async models(id) {
      requirePermission('generation', 'ctx.connections.models')
      const result = await dependencies.connections.models(id)
      assertUsable()
      return result
    },

    setActive(id) {
      requirePermission('generation', 'ctx.connections.setActive')
      dependencies.store.getState().setActiveProfile(id)
    },

    async setActiveAcknowledged(id, reason = 'user_selection') {
      requirePermission('generation', 'ctx.connections.setActive')
      dependencies.store.getState().setActiveProfile(id, reason)
      await dependencies.connections.acknowledgeActive?.({ id, reason })
      assertUsable()
    },

    async update(id, input) {
      requirePermission('generation', 'ctx.connections.update')
      const result = await dependencies.connections.update(id, input)
      assertUsable()
      dependencies.store.getState().updateProfile(id, result)
      return result
    },
  }

  const chats: FrontendChatsAPI = {
    async listForCharacter(characterId) {
      assertUsable()
      const result = await dependencies.chats.listForCharacter(characterId)
      assertUsable()
      return result
    },

    async getMessages(chatId, options) {
      assertUsable()
      const result = await dependencies.chats.getMessages(chatId, {
        ...options,
        limit: boundedLimit(options?.limit),
      })
      assertUsable()
      return result
    },
  }

  const worldBooks: FrontendWorldBooksAPI = {
    async list(options) {
      assertUsable()
      const books = await dependencies.worldBooks.list()
      assertUsable()
      if (!options?.fields?.length) return books
      const fields = new Set(options.fields)
      return books.map((book) => {
        const selected: Record<string, unknown> = {}
        for (const field of fields) {
          if (field in book) selected[field] = book[field as keyof WorldBook]
        }
        return selected
      })
    },

    async entries(bookId) {
      assertUsable()
      const entries = await dependencies.worldBooks.entries(bookId)
      assertUsable()
      return entries
    },
  }

  const messages: FrontendMessagesAPI = {
    getContent(id) {
      assertUsable()
      const message = dependencies.store.getState().messages.find((candidate) => candidate.id === id)
      return clone(message?.content ?? null)
    },

    getRecent(limit) {
      assertUsable()
      const messagesInStore = dependencies.store.getState().messages
      const count = safeRecentLimit(limit)
      return clone(count === 0 ? [] : messagesInStore.slice(-count))
    },
  }

  const tokenTransport = dependencies.tokens ?? denyUnavailableTokenApi()
  const tokens: FrontendTokensAPI = {
    async countText(text, options) {
      assertUsable()
      if (typeof text !== 'string') throw new Error('text must be a string')
      const result = await tokenTransport.countText(text, options)
      assertUsable()
      return result
    },
    async countMessages(messageList, options) {
      assertUsable()
      const normalized = normalizeTokenMessages(messageList)
      const result = await tokenTransport.countText(flattenTokenMessages(normalized), options)
      assertUsable()
      return result
    },
    async countChat(chatId, options) {
      assertUsable()
      const normalizedChatId = requireChatId(chatId)
      const page = await dependencies.chats.getMessages(normalizedChatId, {
        limit: MAX_TOKEN_MESSAGES,
        tail: true,
      })
      assertUsable()
      const normalized = normalizeChatMessages(page)
      const result = await tokenTransport.countText(flattenTokenMessages(normalized), options)
      assertUsable()
      return result
    },
    async countTextBatch(texts, options) {
      assertUsable()
      const result = await tokenTransport.countTextBatch(validateTokenBatch(texts), options)
      assertUsable()
      return result
    },
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    subscribers.clear()
    stopConnectionSubscription()
  }
  dependencies.onTeardown(dispose)

  return { connections, chats, worldBooks, messages, tokens, dispose }
}

export function createUnavailableFrontendTokenApi(): FrontendTokensAPI {
  return denyUnavailableTokenApi()
}
