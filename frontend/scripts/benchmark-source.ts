import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

export function loadBenchmarkFunction<T>(path: string, name: string, ref?: string, globals: Record<string, unknown> = {}): T {
  const checkout = resolve(import.meta.dir, '../..')
  const source = ref
    ? execFileSync('git', ['show', `${ref}:${path}`], { cwd: checkout, encoding: 'utf8' })
    : readFileSync(resolve(checkout, path), 'utf8')
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declarations = new Map<string, ts.Statement>()
  for (const statement of tree.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement)
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      declarations.set(statement.name.text, statement)
    }
  }
  if (!declarations.has(name)) throw new Error(`Benchmark function ${name} was not found in ${path}`)
  const selected = new Set<ts.Statement>()
  function select(identifier: string): void {
    const statement = declarations.get(identifier)
    if (!statement || selected.has(statement)) return
    selected.add(statement)
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) select(node.text)
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(statement, visit)
  }
  select(name)
  const code = tree.statements.filter(statement => selected.has(statement))
    .map(statement => statement.getText(tree)).join('\n').replace(/^export /gm, '')
  return new Function(...Object.keys(globals), new Bun.Transpiler({ loader: 'tsx' }).transformSync(code)
    + `; return ${name};`)(...Object.values(globals)) as T
}

export function measureBenchmarkFixture(
  run: (raw: string) => unknown,
  makeInput: (size: number) => string,
  iterations = 1,
  sizes = [128, 256, 512, 1024, 2048, 4096, 8192],
) {
  const results = []
  let spentMs = 0
  for (const size of sizes) {
    const raw = makeInput(size)
    const samples = []
    let stopped = false
    for (let sample = 0; sample < 3; sample++) {
      const start = performance.now()
      for (let iteration = 0; iteration < iterations; iteration++) run(raw)
      const elapsed = performance.now() - start
      spentMs += elapsed
      samples.push(elapsed / iterations)
      if (elapsed > 250 || spentMs > 1000) { stopped = true; break }
    }
    samples.sort((a, b) => a - b)
    results.push({ size, characters: raw.length, iterations,
      samples: samples.length, medianMs: samples[Math.floor(samples.length / 2)], stopped })
    if (stopped) break
  }
  return results
}
