import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '../../frontend/node_modules/typescript/lib/typescript.js'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const source = ts.createSourceFile('useWebSocket.ts', readFileSync(join(root, 'frontend/src/ws/useWebSocket.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks = new Map()
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'wsClient.on') {
    callbacks.set(node.arguments[0].getText(source), node.arguments[1].getText(source))
  }
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(callbacks.has('EventType.MESSAGE_SENT'))
assert.ok(callbacks.has('EventType.MESSAGE_EDITED'))

// Exercise the production store and WebSocket callbacks with controlled events,
// without credentials, a live backend, or extension installation.
const directory = mkdtempSync(join(tmpdir(), 'runtime-message-browser-'))
try {
  const entry = join(directory, 'fixture.ts')
  const bundle = join(directory, 'fixture.js')
  writeFileSync(entry, `
    import { createStore } from ${JSON.stringify(join(root, 'frontend/node_modules/zustand/vanilla.js'))};
    import { createChatSlice } from ${JSON.stringify(join(root, 'frontend/src/store/slices/chat.ts'))};
    import { getHistoryBoundary } from ${JSON.stringify(join(root, 'frontend/src/lib/history-page-loader.ts'))};
    const store = createStore()(createChatSlice);
    const invalidateDisplayRegexCacheForMessage = () => {};
    const isLocalStreamPlaceholderId = id => typeof id === 'string' && /^__(stream|regen)_placeholder_/.test(id);
    const sent = ${callbacks.get('EventType.MESSAGE_SENT')};
    const edited = ${callbacks.get('EventType.MESSAGE_EDITED')};
    const message = (id, index, isUser = false) => ({ id, chat_id:'chat', index_in_chat:index, is_user:isUser,
      name:'', content:id, send_date:index, created_at:index, extra:{}, swipes:[id], swipe_dates:[index], swipe_id:0, revision:1 });
    store.subscribe(state => {
      document.querySelector('output').textContent = state.messages.map(row => row.id).join(',');
    });
    window.fixture = { store, sent, edited, message, getHistoryBoundary };
  `)
  const build = spawnSync('bun', ['build', entry, '--target=browser', '--tsconfig-override=' + join(root, 'frontend/tsconfig.json'),
    '--define=import.meta.env={}', '--outfile=' + bundle], { encoding: 'utf8', cwd: root })
  assert.equal(build.status, 0, build.stderr)
  const javascript = readFileSync(bundle, 'utf8')
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const width of [1280, 390]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 844 } })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.route('http://fixture.local/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><output></output>' }))
        await page.goto('http://fixture.local/')
        await page.addScriptTag({ content: javascript })
        const result = await page.evaluate(() => {
          const { store, sent, edited, message, getHistoryBoundary } = window.fixture
          store.setState({ activeChatId: 'chat', messages: [message('user', 0, true), message('assistant', 1)], totalChatLength: 2 })
          let state = store.getState()
          state.beginStreaming(undefined, 'continue')
          state.startStreaming('generation', undefined, 'continue')
          store.setState({ streamingContent: 'continuation buffer' })
          sent({ chatId: 'chat', authored: true, inserted: true, message: message('inserted', 1, true) })
          sent({ chatId: 'chat', message: message('generated-completion', 3) })
          state = store.getState()
          const duringStream = { ids: state.messages.map(row => row.id), indexes: state.messages.map(row => row.index_in_chat),
            content: state.streamingContent, streaming: state.isStreaming }
          state.reconcileMessagesTail({ data: [message('user', 0, true), message('assistant', 1)], total: 2, offset: 0,
            requestSnapshot: { ids: ['user', 'assistant'], total: 2 } })
          state.endStreaming()
          const changed = { ...message('assistant', 2, true), revision: 3, content: 'Edited speaker' }
          edited({ chatId: 'chat', message: changed })
          state = store.getState()
          const roleEdit = { role: state.messages.at(-1).is_user, content: state.messages.at(-1).content, total: state.totalChatLength }

          const initial = Array.from({ length: 50 }, (_, index) => message('row-' + (index + 50), index + 50))
          store.setState({ messages: initial, totalChatLength: 100 })
          sent({ chatId: 'chat', authored: true, inserted: true, message: message('offscreen', 0, true) })
          store.getState().reconcileMessagesTail({ data: initial, total: 100, offset: 50,
            requestSnapshot: { ids: initial.map(row => row.id), total: 100 } })
          state = store.getState()
          const boundary = getHistoryBoundary(state.messages)
          const pagination = { id: boundary.id, index: boundary.index_in_chat, loaded: state.messages.length, total: state.totalChatLength }
          state.prependMessages([message('offscreen', 0, true), ...Array.from({ length: 50 }, (_, index) => message('row-' + index, index + 1))])
          state = store.getState()
          return { duringStream, roleEdit, pagination, loaded: state.messages.length, unique: new Set(state.messages.map(row => row.id)).size }
        })
        assert.deepEqual(result, {
          duringStream: { ids: ['user', 'inserted', 'assistant'], indexes: [0, 1, 2], content: 'continuation buffer', streaming: true },
          roleEdit: { role: true, content: 'Edited speaker', total: 3 },
          pagination: { id: 'row-50', index: 51, loaded: 50, total: 101 }, loaded: 101, unique: 101,
        })
        assert.equal((await page.locator('output').textContent()).split(',').length, 101)
        assert.deepEqual(errors, [])
        console.log(name + ' ' + width + 'px: insertion, streaming, role edits, stale responses and history pagination passed')
        await page.close()
      }
    } finally { await runtime.close() }
  }
} finally { rmSync(directory, { recursive: true, force: true }) }
