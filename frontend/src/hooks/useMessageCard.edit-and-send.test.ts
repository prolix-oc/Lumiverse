import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { Message } from '@/types/api'

const editAndSend = mock(() => Promise.resolve({}))
const generateStart = mock(() => Promise.resolve({ generationId: 'gen-swipe' }))
const beginStreaming = mock(() => {})
const startStreaming = mock(() => {})
const setStreamingError = mock(() => {})
const addToast = mock(() => {})
const updateMessage = mock((id: string, next: Message) => {
  storeState.messages = storeState.messages.map((m) => (m.id === id ? { ...m, ...next } : m))
})
const setEditingMessageId = mock((id: string | null) => {
  storeState.editingMessageId = id
})

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'is_user'>): Message {
  return {
    chat_id: 'chat-1',
    index_in_chat: 0,
    name: partial.is_user ? 'User' : 'Assistant',
    content: partial.content ?? 'hello',
    send_date: 1,
    swipe_id: 0,
    swipes: [partial.content ?? 'hello'],
    swipe_dates: [1],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 42,
    ...partial,
  }
}

const user = msg({ id: 'user-1', is_user: true, content: 'hello' })
const assistant = msg({ id: 'asst-1', is_user: false, content: 'hi', index_in_chat: 1 })
const messagesUpdate = mock(() => Promise.resolve({ ...user, content: 'rewritten' }))

const storeState = {
  editingMessageId: 'user-1' as string | null,
  setEditingMessageId,
  updateMessage,
  addToast,
  removeMessage: mock(() => {}),
  openModal: mock(() => {}),
  activeCharacterId: 'char-1',
  characters: [] as Array<{ id: string; name: string }>,
  isStreaming: false,
  messages: [user] as Message[],
  activeProfileId: 'profile-1',
  activePersonaId: null as string | null,
  personas: [] as Array<{ id: string; name: string }>,
  mpRoomId: null as string | null,
  mpIsHost: true,
  mpCharacterAvatar: null,
  mpParticipants: [],
  reasoningSettings: { autoParse: false },
  activeChatAvatarId: null,
  activeChatMetadata: null as Record<string, unknown> | null,
  setActiveChatMetadata: mock(() => {}),
  setActiveChat: mock(() => {}),
  chatSheldDisplayMode: 'minimal',
  regeneratingMessageId: null as string | null,
  streamingSwipeId: null as number | null,
  streamingGenerationType: null as string | null,
  streamingContent: '',
  streamingReasoning: '',
  streamingReasoningDuration: null,
  streamingReasoningStartedAt: null,
  isGroupChat: false,
  beginStreaming,
  startStreaming,
  setStreamingError,
  getActivePresetForGeneration: () => 'preset-1',
}

const useStoreMock = Object.assign(
  <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
  { getState: () => storeState },
)

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('react-router', () => ({ useNavigate: () => mock(() => {}) }))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))
mock.module('@/api/chats', () => ({
  chatsApi: { editAndSend, patchMetadata: mock(), branch: mock() },
  messagesApi: { update: messagesUpdate, delete: mock(), deleteSwipe: mock() },
}))
mock.module('@/api/generate', () => ({
  generateApi: { start: generateStart },
}))
mock.module('@/lib/loom/runtimeProfile', () => ({
  shouldForceLoomRuntimePreset: () => false,
}))
mock.module('@/i18n', () => ({
  default: { t: (key: string) => key },
}))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarThumbUrlById: () => '',
  getCharacterAvatarLargeUrlById: () => '',
  getCharacterAvatarUrlById: () => '',
  getPersonaAvatarThumbUrlById: () => '',
  getPersonaAvatarLargeUrlById: () => '',
  getPersonaAvatarUrlById: () => '',
  getPersonaAvatarTiers: () => ({ sm: '', lg: '', full: '' }),
  getCharacterAvatarTiers: () => ({ sm: '', lg: '', full: '' }),
  getImageTiers: () => ({ sm: '', lg: '', full: '' }),
}))
mock.module('@/api/images', () => ({
  imagesApi: { largeUrl: () => '', smallUrl: () => '', url: () => '' },
}))
mock.module('@/lib/multiplayerMessageAuthor', () => ({
  resolveMultiplayerMessageAuthor: () => null,
}))

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const globalObject = globalThis as unknown as Record<string, unknown>
const originalGlobals = new Map<string, unknown>([
  ['window', globalObject.window],
  ['document', globalObject.document],
  ['navigator', globalObject.navigator],
  ['Node', globalObject.Node],
  ['HTMLElement', globalObject.HTMLElement],
  ['IS_REACT_ACT_ENVIRONMENT', globalObject.IS_REACT_ACT_ENVIRONMENT],
])
Object.assign(globalObject, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { useMessageCard } = await import('./useMessageCard')
const { createRoot } = await import('react-dom/client')

type Surface = ReturnType<typeof useMessageCard>
let hookSurface: Surface
const mountedRoots = new Set<Root>()

function Harness({ message }: { message: Message }) {
  hookSurface = useMessageCard(message, 'chat-1')
  return null
}

async function renderHook(message: Message): Promise<Root> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(createElement(Harness, { message }))
    await Promise.resolve()
  })
  return root
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount()
  })
  mountedRoots.delete(root)
}

describe('useMessageCard edit-and-send', () => {
  beforeEach(() => {
    editAndSend.mockClear()
    messagesUpdate.mockClear()
    generateStart.mockClear()
    beginStreaming.mockClear()
    startStreaming.mockClear()
    addToast.mockClear()
    updateMessage.mockClear()
    setEditingMessageId.mockClear()
    storeState.setActiveChat.mockClear()
    storeState.isStreaming = false
    storeState.editingMessageId = 'user-1'
    storeState.messages = [user]
    messagesUpdate.mockResolvedValue({ ...user, content: 'rewritten' })
  })

  afterEach(async () => {
    for (const root of [...mountedRoots]) await unmount(root)
  })

  afterAll(() => {
    for (const [key, value] of originalGlobals) {
      if (value === undefined) delete globalObject[key]
      else globalObject[key] = value
    }
  })

  test('tail: updates in place and continues generation', async () => {
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('rewritten')
      await Promise.resolve()
    })
    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(messagesUpdate).toHaveBeenCalledWith('chat-1', 'user-1', { content: 'rewritten' })
    expect(generateStart).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 'chat-1',
      generation_type: 'continue',
    }))
    expect(beginStreaming).toHaveBeenCalledWith(undefined, 'continue')
    expect(startStreaming).toHaveBeenCalledWith('gen-swipe', undefined, 'continue')
    expect(storeState.editingMessageId).toBeNull()
    expect(editAndSend).not.toHaveBeenCalled()
    expect(storeState.setActiveChat).not.toHaveBeenCalled()
  })

  test('historical: swipes the subsequent assistant after update', async () => {
    storeState.messages = [user, assistant]
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('rewritten')
      await Promise.resolve()
    })
    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(messagesUpdate).toHaveBeenCalledWith('chat-1', 'user-1', { content: 'rewritten' })
    expect(generateStart).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 'chat-1',
      message_id: 'asst-1',
      generation_type: 'swipe',
    }))
    expect(beginStreaming).toHaveBeenCalledWith('asst-1', 'swipe')
    expect(editAndSend).not.toHaveBeenCalled()
    expect(storeState.setActiveChat).not.toHaveBeenCalled()
  })

  test('empty: does not call the API', async () => {
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('   ')
      await Promise.resolve()
    })
    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(messagesUpdate).not.toHaveBeenCalled()
    expect(generateStart).not.toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })

  test('cancel-before-send: cancel never calls APIs', async () => {
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('rewritten')
      await Promise.resolve()
    })
    await act(async () => {
      hookSurface.handleCancelEdit()
    })

    expect(messagesUpdate).not.toHaveBeenCalled()
    expect(generateStart).not.toHaveBeenCalled()
    expect(editAndSend).not.toHaveBeenCalled()
    expect(beginStreaming).not.toHaveBeenCalled()
  })

  test('failure: restores content and toasts without applying generation', async () => {
    const errorSpy = mock(() => {})
    const originalError = console.error
    console.error = errorSpy as typeof console.error
    messagesUpdate.mockRejectedValueOnce(new Error('conflict'))
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('rewritten')
      await Promise.resolve()
    })
    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(generateStart).not.toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Failed to edit and send',
    }))
    expect(updateMessage).toHaveBeenCalledWith('user-1', expect.objectContaining({ content: 'hello' }))
    console.error = originalError
  })
})
