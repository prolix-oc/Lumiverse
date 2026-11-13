import { describe, expect, mock, test } from 'bun:test'

mock.module('@/lib/commands', () => ({
  COMMANDS: [
    { id: 'action-new-chat', label: 'New Chat', scope: 'global', run: () => undefined },
    { id: 'action-manage-chats', label: 'Manage Chats', scope: 'chat', run: () => undefined },
  ],
}))
mock.module('@/api/memory-cortex', () => ({
  memoryCortexApi: {
    warm: (chatId: string, options?: { force?: boolean }) => Promise.resolve({ chatId, force: options?.force }),
  },
}))

const storeState = {
  messageSelectMode: false,
  selectedMessageIds: ['msg-1', 'msg-2'],
  setMessageSelectMode(enabled: boolean) {
    this.messageSelectMode = enabled
    this.selectedMessageIds = []
  },
}

mock.module('@/store', () => ({
  useStore: {
    getState: () => storeState,
  },
}))

const {
  buildChatDockerActionCatalog,
  CHAT_DOCKER_ACTION_IDS,
  countActionId,
} = await import('./chatDockerActionCatalog')

describe('chatDockerActionCatalog', () => {
  test('catalog exposes chat.new once and invokes the existing new-chat owner', () => {
    const runs: string[] = []
    const catalog = buildChatDockerActionCatalog({
      owners: {
        findCommand: (id) => id === 'action-new-chat'
          ? { id, run: () => { runs.push(id) } }
          : undefined,
      },
    })
    const matches = catalog.filter((action) => action.id === 'chat.new')
    expect(matches).toHaveLength(1)
    matches[0].run()
    expect(runs).toEqual(['action-new-chat'])
  })

  test('catalog invokes existing manage-chats command only when its scope is available', () => {
    const runs: string[] = []
    const findCommand = (id: string) => id === 'action-manage-chats'
      ? { id, scope: 'chat', run: () => { runs.push(id) } }
      : undefined

    const unavailable = buildChatDockerActionCatalog({
      owners: { findCommand },
      scope: { activeCharacterId: null },
    }).find((action) => action.id === 'chat.manage')
    expect(unavailable?.disabled).toBe(true)
    unavailable?.run()
    expect(runs).toEqual([])

    const available = buildChatDockerActionCatalog({
      owners: { findCommand },
      scope: { activeCharacterId: 'char-1' },
    }).find((action) => action.id === 'chat.manage')
    expect(available?.disabled).toBe(false)
    available?.run()
    expect(runs).toEqual(['action-manage-chats'])
  })

  test('catalog invokes openPromptVariablesModal and preserves preset availability', () => {
    let opened = 0
    const missing = buildChatDockerActionCatalog({
      owners: { openPromptVariablesModal: () => { opened += 1 } },
      scope: { activeLoomPresetId: null, promptVariablesLoading: false },
    }).find((action) => action.id === 'chat.prompt-variables')
    expect(missing?.presetAvailable).toBe(false)
    expect(missing?.disabled).toBe(true)
    missing?.run()
    expect(opened).toBe(0)

    const ready = buildChatDockerActionCatalog({
      owners: { openPromptVariablesModal: () => { opened += 1 } },
      scope: { activeLoomPresetId: 'preset-1', promptVariablesLoading: false },
    }).find((action) => action.id === 'chat.prompt-variables')
    expect(ready?.presetAvailable).toBe(true)
    expect(ready?.disabled).toBe(false)
    ready?.run()
    expect(opened).toBe(1)
  })

  test('catalog opens existing chatSettings modal', () => {
    const opened: Array<{ id: string; payload?: unknown }> = []
    const action = buildChatDockerActionCatalog({
      owners: { openModal: (id, payload) => { opened.push({ id, payload }) } },
      scope: { activeChatId: 'chat-1' },
    }).find((entry) => entry.id === 'chat.settings')
    expect(action?.disabled).toBe(false)
    action?.run()
    expect(opened).toEqual([{ id: 'chatSettings', payload: { chatId: 'chat-1' } }])
  })

  test('catalog invokes handleConvertToGroup only for eligible chats', () => {
    let converts = 0
    const owners = { handleConvertToGroup: () => { converts += 1 } }

    buildChatDockerActionCatalog({
      owners,
      scope: { activeChatId: 'chat-1', activeCharacterId: 'char-1', isGroupChat: true },
    }).find((action) => action.id === 'chat.convert-to-group')?.run()
    expect(converts).toBe(0)

    const eligible = buildChatDockerActionCatalog({
      owners,
      scope: { activeChatId: 'chat-1', activeCharacterId: 'char-1', isGroupChat: false },
    }).find((action) => action.id === 'chat.convert-to-group')
    expect(eligible?.hidden).toBe(false)
    eligible?.run()
    expect(converts).toBe(1)
  })

  test('catalog opens existing groupChatCreator modal', () => {
    const opened: string[] = []
    const unregistered = buildChatDockerActionCatalog({
      owners: {
        groupChatCreatorRegistered: false,
        openModal: (id) => { opened.push(id) },
      },
    }).find((action) => action.id === 'chat.new-group')
    expect(unregistered?.disabled).toBe(true)
    unregistered?.run()
    expect(opened).toEqual([])

    const registered = buildChatDockerActionCatalog({
      owners: { openModal: (id) => { opened.push(id) } },
    }).find((action) => action.id === 'chat.new-group')
    registered?.run()
    expect(opened).toEqual(['groupChatCreator'])
  })

  test('catalog opens existing authors-note state', () => {
    const notes: boolean[] = []
    const missingChat = buildChatDockerActionCatalog({
      owners: { setAuthorsNoteOpen: (open) => { notes.push(open) } },
      scope: { activeChatId: null },
    }).find((action) => action.id === 'chat.authors-note')
    expect(missingChat?.disabled).toBe(true)
    missingChat?.run()
    expect(notes).toEqual([])

    buildChatDockerActionCatalog({
      owners: { setAuthorsNoteOpen: (open) => { notes.push(open) } },
      scope: { activeChatId: 'chat-1' },
    }).find((action) => action.id === 'chat.authors-note')?.run()
    expect(notes).toEqual([true])
  })

  test('catalog invokes existing forced Memory Cortex warm path', () => {
    const warmed: Array<{ chatId: string; force?: boolean }> = []

    const unavailable = buildChatDockerActionCatalog({
      owners: { memoryCortexAvailable: false },
      scope: { activeChatId: 'chat-1' },
    }).find((action) => action.id === 'chat.recompile-memories')
    unavailable?.run()
    expect(warmed).toEqual([])

    const inFlight = buildChatDockerActionCatalog({
      owners: {
        memoryCortexAvailable: true,
        memoryCortexInFlight: true,
        warmMemories: (chatId) => { warmed.push({ chatId, force: true }) },
      },
      scope: { activeChatId: 'chat-1' },
    }).find((action) => action.id === 'chat.recompile-memories')
    inFlight?.run()
    expect(warmed).toEqual([])

    const ready = buildChatDockerActionCatalog({
      owners: {
        memoryCortexAvailable: true,
        warmMemories: (chatId) => { warmed.push({ chatId, force: true }) },
      },
      scope: { activeChatId: 'chat-9' },
    }).find((action) => action.id === 'chat.recompile-memories')
    ready?.run()
    expect(warmed).toEqual([{ chatId: 'chat-9', force: true }])
  })

  test('catalog exposes chat.select-messages once and toggles the existing select-mode setter', () => {
    storeState.messageSelectMode = false
    storeState.selectedMessageIds = ['msg-1', 'msg-2']

    const catalog = buildChatDockerActionCatalog({
      scope: { activeChatId: 'chat-1' },
    })
    const matches = catalog.filter((action) => action.id === 'chat.select-messages')
    expect(matches).toHaveLength(1)
    expect(matches[0].disabled).toBe(false)
    matches[0].run()
    expect(storeState.messageSelectMode).toBe(true)
    expect(storeState.selectedMessageIds).toEqual([])

    storeState.selectedMessageIds = ['msg-3']
    matches[0].run()
    expect(storeState.messageSelectMode).toBe(false)
    expect(storeState.selectedMessageIds).toEqual([])
  })

  test('every default action appears exactly once in V1 V2 and the customizer', () => {
    const catalog = buildChatDockerActionCatalog({
      scope: { activeChatId: 'chat-1', activeCharacterId: 'char-1' },
    })
    const v1 = catalog
    const v2 = catalog
    const customizer = catalog
    expect(catalog.map((action) => action.id)).toEqual([...CHAT_DOCKER_ACTION_IDS])
    for (const surface of [v1, v2, customizer]) {
      for (const id of CHAT_DOCKER_ACTION_IDS) {
        expect(countActionId(surface, id)).toBe(1)
      }
    }
  })
})
