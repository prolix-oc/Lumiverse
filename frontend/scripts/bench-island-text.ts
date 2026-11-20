import { marked } from 'marked'
import { ISLAND_BLANK_LINE_RE } from '../src/components/chat/htmlIslandMarkdown'
import { loadBenchmarkFunction, measureBenchmarkFixture } from './benchmark-source'

// Usage: bun scripts/bench-island-text.ts [git-ref|-] [target]
const ref = process.argv[2] === '-' ? undefined : process.argv[2]
const target = process.argv[3]
const path = 'frontend/src/components/chat/MessageContent.tsx'
const globals = { marked, ISLAND_BLANK_LINE_RE }
const cases = {
  islandBlockWhitespace: {
    functionName: 'renderIslandMarkdownText', normal: ' \tHello **world**.\t ',
    fixtures: {
      interiorSpaces: (n: number) => 'a' + ' '.repeat(n) + 'b',
      trailingSpaces: (n: number) => 'a' + ' '.repeat(n),
    },
  },
  islandInlineWhitespace: {
    functionName: 'renderIslandInlineMarkdownText', normal: ' \tHello **world**.\t ',
    fixtures: {
      interiorSpaces: (n: number) => 'a' + ' '.repeat(n) + 'b',
      trailingSpaces: (n: number) => 'a' + ' '.repeat(n),
    },
  },
}
if (target && !(target in cases)) throw new Error(`Unknown benchmark target: ${target}`)
const results = []
for (const [name, group] of Object.entries(cases)) {
  if (target && target !== name) continue
  const run = loadBenchmarkFunction<(raw: string) => unknown>(path, group.functionName, ref, globals)
  run(group.normal)
  const fixtures: Record<string, (n: number) => string> = { normal: () => group.normal, ...group.fixtures }
  for (const [fixture, makeInput] of Object.entries(fixtures)) {
    const iterations = fixture === 'normal' ? 100 : 1
    const rows = measureBenchmarkFixture(run, makeInput, iterations, fixture === 'normal' ? [1] : undefined)
    results.push(...rows.map(row => ({ target: name, fixture, ...row })))
  }
}
console.log(JSON.stringify({ ref: ref ?? 'working tree', bun: Bun.version,
  method: 'Actual island text helpers including Markdown; one normal-input warmup and up to three samples per input. Normal inputs use batches; larger inputs double from 128 to 8192. Stop a fixture after a batch exceeds 250 ms or total measured time exceeds 1000 ms. Limits are checked between calls. Excludes source loading, DOM, layout and paint.',
  results }, null, 2))
