import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

// Check runtime imports, excluding erased type imports and deferred imports.
// The store must finish construction before its UI consumers can run; the
// route tree must not be imported back by components mounted within it.
const sourceRoot = resolve(import.meta.dirname, '../src')
const graph = new Map<string, string[]>()
function scan(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) { scan(file); continue }
    if (!/\.[jt]sx?$/.test(file) || /\.(test|isolated|slow|vite)[.-]|\.d\.ts$/.test(file)) continue
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const edges: string[] = []
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue
      if (ts.isExportDeclaration(node) && node.isTypeOnly) continue
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined
      if (clause?.isTypeOnly) continue
      const bindings = clause?.namedBindings ?? (ts.isExportDeclaration(node) ? node.exportClause : undefined)
      if (bindings && 'elements' in bindings && bindings.elements.length && !clause?.name
        && bindings.elements.every(item => item.isTypeOnly)) continue
      const specifier = node.moduleSpecifier.text
      const base = specifier.startsWith('@/') ? join(sourceRoot, specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null
      if (!base) continue
      const target = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
        .find(path => /\.[jt]sx?$/.test(path) && existsSync(path))
      if (target) edges.push(target)
    }
    graph.set(file, edges)
  }
}
scan(sourceRoot)

function cycleThrough(start: string): string[] | undefined {
  const queue = [[start]], seen = new Set([start])
  for (const path of queue) {
    for (const next of graph.get(path.at(-1)!) ?? []) {
      if (next === start) return [...path, next].map(file => relative(sourceRoot, file))
      if (!seen.has(next)) { seen.add(next); queue.push([...path, next]) }
    }
  }
}

for (const entry of ['store/index.ts', 'router.tsx', 'lib/spindle/loader.ts', 'lib/spindle/productivity-host-surface-renderers.tsx']) {
  test(`${entry} has no eager circular dependencies`, () => {
    expect(graph.has(join(sourceRoot, entry))).toBe(true)
    expect(cycleThrough(join(sourceRoot, entry))).toBeUndefined()
  })
}
