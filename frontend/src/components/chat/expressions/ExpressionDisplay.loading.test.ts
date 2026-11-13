import { expect, test } from 'bun:test'
import ts from 'typescript'
import { resolveExpression } from '@/lib/expressionResolution'

const source = await Bun.file(new URL('./ExpressionDisplay.tsx', import.meta.url)).text()
const file = ts.createSourceFile('ExpressionDisplay.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let effect = ''
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
    && node.arguments[0]?.getText(file).includes('const fallback = resolveExpression')) effect = node.arguments[0].getText(file)
  ts.forEachChild(node, visit)
}
visit(file)
if (!effect) throw new Error('Expression selection effect missing')
const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const effect = ${effect}`)
const config = { enabled: true, defaultExpression: 'default', mappings: { default: 'default-image', saved: 'saved-image', live: 'live-image' } }

function select(overrides: Record<string, unknown> = {}) {
  const selected: unknown[] = []
  const deps = {
    activeChatId: 'chat', activeChatMetadata: {}, hasExpressions: true, exprConfig: config,
    resolvedCharId: 'character', loadedConfigCharId: 'character', savedExpression: 'saved',
    lastResolvedKey: { current: '' }, useStore: { getState: () => ({}) }, resolveExpression,
    setActiveExpression: (...args: unknown[]) => selected.push(args), ...overrides,
  }
  new Function(...Object.keys(deps), `${compiled}; effect()`)(...Object.values(deps))
  return selected
}

test('restores the saved expression using the display config, falling back for missing labels', () => {
  expect(select()).toEqual([['saved', 'saved-image', 'character']])
  expect(select({ savedExpression: 'removed' })).toEqual([['default', 'default-image', 'character']])
})

test('waits for metadata and the matching character config, and preserves live expression events', () => {
  expect(select({ activeChatMetadata: null })).toEqual([])
  expect(select({ loadedConfigCharId: 'old-character' })).toEqual([])
  expect(select({ useStore: { getState: () => ({ currentExpression: 'live', expressionCharacterId: 'character' }) } })).toEqual([])
})

test('returning to the same character in another chat restores that chat independently', () => {
  const key = { current: '' }
  expect(select({ lastResolvedKey: key })).toHaveLength(1)
  expect(select({ lastResolvedKey: key })).toHaveLength(0)
  expect(select({ lastResolvedKey: key, activeChatId: 'other-chat' })).toEqual([['saved', 'saved-image', 'character']])
})
