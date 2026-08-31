import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import type { EditAndSendInput, EditAndSendResult } from '@/api/chats'
import type { Message } from '@/types/api'

const editAndSend = mock((_chatId: string, _input: EditAndSendInput): Promise<EditAndSendResult> => Promise.resolve({
  branchChatId: 'branch-1',
  editedMessageId: 'branch-user-1',
  immediateAssistantId: null,
  generationCursor: {
    generationId: 'gen-1',
    chatId: 'branch-1',
    requestId: 'server-request-1',
    mode: 'normal' as const,
  },
}))
const generateStart = mock(() => Promise.resolve({ generationId: 'gen-swipe' }))
const navigate = mock((_path: string) => {})
const beginStreaming = mock(() => {})
const startStreaming = mock(() => {})
const setStreamingError = mock(() => {})
const addToast = mock(() => {})
const preloadChatNavigationSnapshotById = mock(() => Promise.resolve())
const preloadChatNavigationSnapshot = mock(() => Promise.resolve())
const updateMessage = mock((id: string, next: Message) => {
  storeState.messages = storeState.messages.map((m) => (m.id === id ? { ...m, ...next } : m))
  notifyStore()
})

const storeListeners = new Set<() => void>()
let storeVersion = 0
function notifyStore(): void {
  storeVersion++
  for (const listener of storeListeners) listener()
}
const setEditingMessageId = mock((id: string | null) => {
  storeState.editingMessageId = id
  notifyStore()
})
const clearMessageEdit = mock(() => {
  storeState.editingMessageId = null
  storeState.messageEditDraft = null
  notifyStore()
})
const beginMessageEdit = mock((draft: MessageEditDraft) => {
  storeState.editingMessageId = draft.messageId
  storeState.messageEditDraft = { ...draft, dirty: false, focusRequested: true }
  notifyStore()
})
const updateMessageEditDraft = mock((patch: Partial<MessageEditDraft>) => {
  storeState.messageEditDraft = storeState.messageEditDraft
    ? { ...storeState.messageEditDraft, ...patch, dirty: true }
    : null
  notifyStore()
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

const user = msg({ id: 'user-1', is_user: true, content: 'hello', revision: 7 })
const assistant = msg({ id: 'asst-1', is_user: false, content: 'hi', index_in_chat: 1 })
const messagesUpdate = mock(() => Promise.resolve({ ...user, content: 'rewritten' }))

type MessageEditDraft = {
  chatId: string
  messageId: string
  content: string
  reasoning?: string
  showReasoningEditor?: boolean
  hadReasoning?: boolean
  dirty?: boolean
  focusRequested?: boolean
}

const storeState = {
  editingMessageId: 'user-1' as string | null,
  messageEditDraft: null as MessageEditDraft | null,
  setEditingMessageId,
  clearMessageEdit,
  beginMessageEdit,
  updateMessageEditDraft,
  updateMessage,
  addToast,
  removeMessage: mock(() => {}),
  openModal: mock(() => {}),
  activeCharacterId: 'char-1',
  characters: [] as Array<{ id: string; name: string }>,
  isStreaming: false,
  totalChatLength: 1,
  messages: [user] as Message[],
  activeProfileId: 'profile-1',
  activePersonaId: null as string | null,
  personas: [] as Array<{ id: string; name: string }>,
  mpRoomId: null as string | null,
  mpIsHost: true,
  mpCharacterAvatar: null,
  mpParticipants: [],
  reasoningSettings: { autoParse: false },
  quickToolbarSettings: { branchChatOnEditAndSend: true } as { branchChatOnEditAndSend?: boolean },
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
  agentActivityRunsByGeneration: {},
  isGroupChat: false,
  beginStreaming,
  startStreaming,
  setStreamingError,
  getActivePresetForGeneration: () => 'preset-1',
}

let storeSnapshot = { v: -1, state: storeState }
function getStoreSnapshot(): { v: number; state: typeof storeState } {
  if (storeSnapshot.v !== storeVersion) storeSnapshot = { v: storeVersion, state: storeState }
  return storeSnapshot
}

const useStoreMock = Object.assign(
  <T,>(selector: (state: typeof storeState) => T): T => selector(useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener)
      return () => { storeListeners.delete(listener) }
    },
    getStoreSnapshot,
    getStoreSnapshot,
  ).state),
  { getState: () => storeState },
)

mock.module('@/store', () => ({ useStore: useStoreMock }))
mock.module('react-router', () => ({ useNavigate: () => navigate }))
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
let nextRequestId = 0
mock.module('@/lib/uuid', () => ({
  generateUUID: () => `request-${++nextRequestId}`,
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
mock.module('@/lib/chatNavigationSnapshot', () => ({
  preloadChatNavigationSnapshot,
  preloadChatNavigationSnapshotById,
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
  // eslint-disable-next-line react-compiler/react-compiler
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
    editAndSend.mockResolvedValue({
      branchChatId: 'branch-1',
      editedMessageId: 'branch-user-1',
      immediateAssistantId: null,
      generationCursor: {
        generationId: 'gen-1',
        chatId: 'branch-1',
        requestId: 'server-request-1',
        mode: 'normal',
      },
    })
    messagesUpdate.mockClear()
    generateStart.mockClear()
    beginStreaming.mockClear()
    startStreaming.mockClear()
    addToast.mockClear()
    preloadChatNavigationSnapshot.mockClear()
    preloadChatNavigationSnapshotById.mockClear()
    updateMessage.mockClear()
    setEditingMessageId.mockClear()
    clearMessageEdit.mockClear()
    beginMessageEdit.mockClear()
    updateMessageEditDraft.mockClear()
    navigate.mockClear()
    nextRequestId = 0
    storeState.setActiveChat.mockClear()
    storeState.isStreaming = false
    storeState.quickToolbarSettings = { branchChatOnEditAndSend: true }
    storeState.editingMessageId = 'user-1'
    storeState.messageEditDraft = {
      chatId: 'chat-1',
      messageId: 'user-1',
      content: 'hello',
      dirty: false,
      focusRequested: false,
    }
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

  test('tail: submits one durable transaction and opens its branch', async () => {
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('rewritten')
      await Promise.resolve()
    })
    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(editAndSend).toHaveBeenCalledWith('chat-1', {
      messageId: 'user-1',
      content: 'rewritten',
      expectedVersion: 7,
      requestId: 'request-1',
      branchChatOnEditAndSend: true,
    })
    expect(editAndSend).toHaveBeenCalledTimes(1)
    expect(messagesUpdate).not.toHaveBeenCalled()
    expect(generateStart).not.toHaveBeenCalled()
    expect(beginStreaming).not.toHaveBeenCalled()
    expect(startStreaming).not.toHaveBeenCalled()
    expect(updateMessage).not.toHaveBeenCalled()
    expect(clearMessageEdit).toHaveBeenCalled()
    expect(preloadChatNavigationSnapshotById).toHaveBeenCalledWith('branch-1', 50)
    expect(storeState.editingMessageId).toBeNull()
    expect(storeState.messageEditDraft).toBeNull()
    expect(navigate).toHaveBeenCalledWith('/chat/branch-1')
  })

  test('in-place mode submits the flag without navigating to a branch', async () => {
    storeState.quickToolbarSettings = { branchChatOnEditAndSend: false }
    editAndSend.mockResolvedValueOnce({
      branchChatId: 'chat-1',
      editedMessageId: 'user-1',
      immediateAssistantId: null,
      generationCursor: { generationId: 'gen-3', chatId: 'chat-1', requestId: 'server-request-3', mode: 'normal' },
    })
    await renderHook(user)
    await act(async () => { hookSurface.setEditContent('rewritten'); await Promise.resolve() })
    await act(async () => { await hookSurface.handleEditAndSend() })
    expect(editAndSend).toHaveBeenCalledWith('chat-1', expect.objectContaining({ branchChatOnEditAndSend: false }))
    expect(preloadChatNavigationSnapshotById).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  test('historical: leaves swipe dispatch to the durable endpoint', async () => {
    storeState.messages = [user, assistant]
    editAndSend.mockResolvedValueOnce({
      branchChatId: 'branch-2',
      editedMessageId: 'branch-user-2',
      immediateAssistantId: 'branch-asst-2',
      generationCursor: {
        generationId: 'gen-2',
        chatId: 'branch-2',
        requestId: 'server-request-2',
        mode: 'swipe',
      },
    })
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('rewritten')
      await Promise.resolve()
    })
    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(editAndSend).toHaveBeenCalledTimes(1)
    expect(messagesUpdate).not.toHaveBeenCalled()
    expect(generateStart).not.toHaveBeenCalled()
    expect(beginStreaming).not.toHaveBeenCalled()
    expect(preloadChatNavigationSnapshotById).toHaveBeenCalledWith('branch-2', 50)
    expect(navigate).toHaveBeenCalledWith('/chat/branch-2')
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

    expect(editAndSend).not.toHaveBeenCalled()
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

  test('failure: keeps the edit open and reuses the request id on retry', async () => {
    const errorSpy = mock(() => {})
    const originalError = console.error
    console.error = errorSpy as typeof console.error
    editAndSend.mockRejectedValueOnce(new Error('response lost'))
    await renderHook(user)
    await act(async () => {
      hookSurface.setEditContent('rewritten')
      await Promise.resolve()
    })
    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(editAndSend).toHaveBeenCalledTimes(1)
    expect(editAndSend.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ requestId: 'request-1' }))
    expect(clearMessageEdit).not.toHaveBeenCalled()
    expect(storeState.editingMessageId).toBe('user-1')
    expect(storeState.messageEditDraft?.content).toBe('rewritten')
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'response lost',
    }))

    await act(async () => {
      await hookSurface.handleEditAndSend()
    })

    expect(editAndSend).toHaveBeenCalledTimes(2)
    expect(editAndSend.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ requestId: 'request-1' }))
    expect(messagesUpdate).not.toHaveBeenCalled()
    expect(generateStart).not.toHaveBeenCalled()
    expect(updateMessage).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/chat/branch-1')
    console.error = originalError
  })
})
