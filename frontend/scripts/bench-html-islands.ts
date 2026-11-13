import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const checkout = resolve(import.meta.dir, '../..')
const path = 'frontend/src/components/chat/MessageContent.tsx'
const ref = process.argv[2]
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
const selected = new Set<ts.Statement>()
function select(name: string): void {
  const statement = declarations.get(name)
  if (!statement || selected.has(statement)) return
  selected.add(statement)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) select(node.text)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(statement, visit)
}
select('extractHtmlIslands')
const code = tree.statements.filter(statement => selected.has(statement))
  .map(statement => statement.getText(tree)).join('\n').replace(/^export /gm, '')
// Execute the actual detector without including React, DOM setup or build time in measurements.
const extract = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(code)
  + '; return extractHtmlIslands;')() as (raw: string, streaming: boolean) => unknown

const style = '<style>.widget{color:red}</style>'
const nested = (size: number) => '<div style="padding:1px">'.repeat(size) + 'Text' + '</div>'.repeat(size)
const fixtures = {
  inline: nested,
  styleBefore: (size: number) => style + '\n\nProse\n\n' + nested(size),
  styleAfter: (size: number) => nested(size) + '\n\nProse\n\n' + style,
  fencedStyle: (size: number) => '```html\n' + style + '\n```\n' + nested(size),
  nestedFences: (size: number) => '<div><style></style>\n```\nx\n```\n'.repeat(size) + '</div>'.repeat(size) + '<p>tail</p>',
  longCrLfLine: (size: number) => 'x'.repeat(size * 16) + '\r\n' + style,
  longCrLine: (size: number) => 'x'.repeat(size * 16) + '\r' + style,
  longUnicodeLine: (size: number) => 'x'.repeat(size * 16) + '\u2028' + style,
  flat: (size: number) => '<div style="padding:1px"><span style="color:red">Text</span></div>\n'.repeat(size) + '\nProse\n' + style,
  incomplete: (size: number) => '<div style="padding:1px">'.repeat(size) + style,
  incompleteStyles: (size: number) => '<style>'.repeat(size),
  incompleteTags: (size: number) => '<div>' + '<div '.repeat(size) + '<style ',
}
const results = []
for (const [name, fixture] of Object.entries(fixtures)) {
  for (const size of [64, 256, 1024]) {
    const raw = fixture(size)
    const streaming = name.startsWith('incomplete')
    for (let i = 0; i < 5; i++) extract(raw, streaming)
    const samples = []
    for (let i = 0; i < 9; i++) {
      const start = performance.now()
      extract(raw, streaming)
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    results.push({ name, size, characters: raw.length, medianMs: samples[4], maxMs: samples[8] })
  }
}
console.log(JSON.stringify({ ref: ref ?? 'working tree', bun: Bun.version,
  method: 'Extraction only; five warmups and nine samples per fixture. Excludes DOM, layout and paint.', results }, null, 2))
