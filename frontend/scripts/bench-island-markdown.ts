import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const checkout = resolve(import.meta.dir, '../..')
const path = 'frontend/src/components/chat/htmlIslandMarkdown.ts'
const ref = process.argv[2]
const source = ref
  ? execFileSync('git', ['show', `${ref}:${path}`], { cwd: checkout, encoding: 'utf8' })
  : readFileSync(resolve(checkout, path), 'utf8')
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(/^export /gm, ''))
const render = new Function(code + '; return processMarkdownInHtmlIsland;')() as (
  html: string, renderer: { renderBlockText: (text: string) => string; renderInlineText: (text: string) => string },
) => string
const renderer = { renderBlockText: (text: string) => text, renderInlineText: (text: string) => text }
const fixtures = {
  styles: (size: number) => '<div>' + '<style>.x{color:red}</style>'.repeat(size) + '</div>',
  unfinishedStyles: (size: number) => '<div>' + '<style>'.repeat(size) + '</div>',
  nestedText: (size: number) => '<div>x'.repeat(size) + '</div>'.repeat(size),
  unmatchedCloses: (size: number) => '<div>'.repeat(size) + '</span>'.repeat(size) + 'x',
  crossedCloses: (size: number) => '<div><span>'.repeat(size) + '</div>'.repeat(size) + '</span>'.repeat(size) + 'x',
  text: (size: number) => '<div>' + 'plain text '.repeat(size) + '</div>',
}
const results = []
for (const [name, fixture] of Object.entries(fixtures)) {
  for (const size of [1, 128, 512, 2048, 8192]) {
    const raw = fixture(size)
    for (let i = 0; i < 3; i++) render(raw, renderer)
    const samples = []
    for (let i = 0; i < 7; i++) {
      const start = performance.now()
      const result = render(raw, renderer)
      samples.push(performance.now() - start)
      if (result !== raw) throw new Error(`Unexpected output for ${name} at ${size}`)
    }
    samples.sort((a, b) => a - b)
    results.push({ name, size, characters: raw.length, medianMs: samples[3], maxMs: samples[6] })
  }
}
console.log(JSON.stringify({ ref: ref ?? 'working tree', bun: Bun.version,
  method: 'Actual island helper with identity text callbacks; three warmups and seven samples. Excludes Markdown callbacks, DOM, layout and paint.', results }, null, 2))
