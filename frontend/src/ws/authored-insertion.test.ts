import { expect, test } from 'bun:test'
import ts from 'typescript'
import { preserveNewerMessageRevisions, reconcileMessageTail, reconciledTailTotal } from '../store/messageTailReconciliation'

const parse = (name: string, source: string) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const slice = parse('chat.ts', await Bun.file(new URL('../store/slices/chat.ts', import.meta.url)).text())
let factorySource = ''
function findFactory(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(slice) === 'createChatSlice') factorySource = node.initializer!.getText(slice)
  ts.forEachChild(node, findFactory)
}
findFactory(slice)
const callbacks = new Map<string, string>()
const websocket = parse('useWebSocket.ts', await Bun.file(new URL('./useWebSocket.ts', import.meta.url)).text())
function findCallbacks(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(websocket) === 'wsClient.on') callbacks.set(node.arguments[0]!.getText(websocket).replace('EventType.', ''), node.arguments[1]!.getText(websocket))
  ts.forEachChild(node, findCallbacks)
}
findCallbacks(websocket)
function compile(source: string, dependencies: Record<string, unknown>) {
  const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const invoke = ${source};`)
  return new Function(...Object.keys(dependencies), `${compiled}; return invoke;`)(...Object.values(dependencies))
}

test.each([true, false])('authored insertion preserves continuation order and stream content, is_user=%s', isUser => {
  const state: any = {}
  Object.assign(state, compile(factorySource, { settingsApi: { put: async () => {} }, preserveNewerMessageRevisions, reconcileMessageTail, reconciledTailTotal })(
    (next: any) => Object.assign(state, typeof next === 'function' ? next(state) : next), () => state))
  const dependencies = { store: { getState: () => state }, invalidateDisplayRegexCacheForMessage() {}, isLocalStreamPlaceholderId: () => false }
  const sent = compile(callbacks.get('MESSAGE_SENT')!, dependencies)
  const message = (id: string, index: number, is_user: boolean, date: number) => ({ id, chat_id: 'chat', index_in_chat: index,
    is_user, content: id, send_date: date, created_at: date, extra: {}, swipes: [id], swipe_dates: [date], swipe_id: 0, revision: 1 })
  state.activeChatId = 'chat'
  state.messages = [message('user', 0, true, 1), message('assistant', 1, false, 2)]
  state.totalChatLength = 2
  state.beginStreaming(undefined, 'continue')
  state.startStreaming('generation', undefined, 'continue')
  state.streamingContent = 'continuation buffer'
  sent({ chatId: 'chat', authored: true, inserted: true, message: message('inserted', 1, isUser, 3) })
  expect(state.messages.map((row: any) => [row.id, row.index_in_chat])).toEqual([['user', 0], ['inserted', 1], ['assistant', 2]])
  expect(state.messages.at(-1).content).toBe('assistant')
  expect(state.streamingContent).toBe('continuation buffer')
  expect(state.isStreaming).toBe(true)
  expect(state.messages.at(-1).index_in_chat).toBe(2)
  sent({ chatId: 'chat', message: message('generated-completion', 3, false, 4) })
  expect(state.messages).toHaveLength(3)
  state.messages = [message('user', 0, true, 1), message('assistant', 1, false, 2)]
  state.totalChatLength = 2
  state.beginStreaming(undefined, 'continue')
  state.startStreaming('finished-generation', undefined, 'continue')
  state.markGenerationEnded('finished-generation', true)
  const completion = { ...message('assistant', 1, false, 2), content: 'assistant completed', swipes: ['assistant completed'], revision: 2 }
  sent({ chatId: 'chat', authored: true, inserted: true, message: message('inserted', 1, isUser, 3) })
  state.reconcileMessagesTail({ data: [message('user', 0, true, 1), message('assistant', 1, false, 2)], total: 2, offset: 0, requestSnapshot: { ids: ['user', 'assistant'], total: 2 } })
  expect(state.messages.find((row: any) => row.id === 'assistant').index_in_chat).toBe(2)
  state.reconcileMessagesTail({ data: [message('user', 0, true, 1), message('inserted', 1, isUser, 3), { ...completion, index_in_chat: 2, revision: 3 }], total: 3, offset: 0 })
  state.endStreaming()
  expect(state.messages.find((row: any) => row.id === 'assistant').content).toBe('assistant completed')
  expect(state.messages.map((row: any) => row.id)).toEqual(['user', 'inserted', 'assistant'])
  expect(state.totalChatLength).toBe(3)
})
