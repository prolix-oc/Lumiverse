import { describe, expect, test } from 'bun:test'
import { shouldSyncExtensionsAfterConnected } from './connected-extension-sync'
import ts from 'typescript'

describe('CONNECTED extension sync', () => {
  test('ignores the local socket-open emission and syncs only after server authentication', () => {
    expect([
      undefined,
      {},
      { role: 'owner' },
    ].filter(shouldSyncExtensionsAfterConnected)).toEqual([{ role: 'owner' }])
  })
})

test('the socket-open phase starts no settings, recovery or chat-head requests', async () => {
  const source = await Bun.file(new URL('./useWebSocket.ts', import.meta.url)).text()
  const file = ts.createSourceFile('useWebSocket.ts', source, ts.ScriptTarget.Latest, true)
  let handler = ''
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'wsClient.on'
      && node.arguments[0]?.getText(file) === 'EventType.CONNECTED') handler = node.arguments[1].getText(file)
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(handler).not.toBe('')
  const calls: string[] = []
  const state = { user: { id: 'user' }, activeChatId: 'chat',
    reconcileRole() {}, setWsAuthSynced() {},
    loadSettings() { calls.push('settings') },
    reconcileChatHeads() { calls.push('heads'); return Promise.resolve() },
  }
  const deps = {
    bindProviderProjection: () => ({ beginReconnectResync() { calls.push('resync') } }),
    store: { getState: () => state }, shouldSyncExtensionsAfterConnected,
    wsClient: { forcePing() {} }, syncExtensions() {}, hasUnsavedSettings: () => false,
    recoverPooledGeneration: async () => { calls.push('recovery') },
  }
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const handler = ${handler}`)
  const onConnected = new Function(...Object.keys(deps), `${compiled}; return handler`)(...Object.values(deps))
  onConnected({})
  expect(calls).toEqual(['resync'])
  onConnected({ role: 'owner' })
  expect(calls).toEqual(['resync', 'settings', 'recovery', 'heads'])
})
