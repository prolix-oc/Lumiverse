import { expect, mock, test } from 'bun:test'
import ts from 'typescript'

const source = await Bun.file(new URL('./InputArea.tsx', import.meta.url)).text()
const file = ts.createSourceFile('InputArea.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let fields = '', prune = '', persist = ''
function visit(node: ts.Node) {
  if (ts.isCallExpression(node)) {
    const callback = node.arguments[0]?.getText(file) ?? ''
    if (node.expression.getText(file) === 'useMemo' && callback.includes('Cached cards can populate controls')) fields = callback
    if (node.expression.getText(file) === 'useEffect' && callback.includes('Failed to clear stale group selections')) persist = callback
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'pruneAltSelections' && node.initializer && ts.isCallExpression(node.initializer)) {
    prune = node.initializer.arguments[0].getText(file)
  }
  ts.forEachChild(node, visit)
}
visit(file)
if (!fields || !prune || !persist) throw new Error('Alternate field loading/pruning functions missing')
function run(callback: string, deps: Record<string, unknown>) {
  const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const callback = ${callback}`)
  return new Function(...Object.keys(deps), `${compiled}; return callback()`)(...Object.values(deps))
}
const pruneCompiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const prune = ${prune}`)
const pruneAltSelections = new Function(`${pruneCompiled}; return prune`)()

function controls(loadedCharacterIds: string[] | null, isGroupChat = false) {
  const data = run(fields, {
    activeCharacterId: 'character', characters: [{ id: 'character', extensions: {} }],
    groupCharacterIds: ['character', 'unavailable'], isGroupChat, loadedCharacterIds,
  })
  const patchMetadata = mock(async () => ({}))
  run(persist, { ...data, chatId: 'chat', isGroupChat, pruneAltSelections,
    altFieldSelections: { description: 'saved-variant' }, groupAltFieldSelections: { character: { description: 'saved-variant' } },
    setAltFieldSelections() {}, setGroupAltFieldSelections() {}, chatsApi: { patchMetadata },
  })
  return { data, patchMetadata }
}

test('cached solo cards cannot erase saved alternate fields before their fresh read', () => {
  expect(controls(null).patchMetadata).not.toHaveBeenCalled()
  expect(controls(['character']).patchMetadata).toHaveBeenCalledWith('chat', { alternate_field_selections: null })
})

test('groups prune only successfully refreshed members', () => {
  expect(controls(null, true).patchMetadata).not.toHaveBeenCalled()
  const loaded = controls(['character'], true)
  expect(loaded.data.groupAltFieldsLoadedIds).toEqual(['character'])
  expect(loaded.patchMetadata).toHaveBeenCalledWith('chat', { group_alternate_field_selections: null })
})
