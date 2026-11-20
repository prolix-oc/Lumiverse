import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { resolveViteRuntime } from './build-frontend'

// Full app + PWA, fresh process per build, same build ID and dependencies.
// Output stays under .tmp so the comparison never replaces the live dist.
const frontend = resolve(import.meta.dirname, '..')
const directory = join(frontend, '.tmp', 'compiler-benchmark')
mkdirSync(directory, { recursive: true })
const modes = ['babel', 'native'] as const
type Mode = typeof modes[number]
const samples: Record<Mode, number[]> = { babel: [], native: [] }

async function run(mode: Mode, label: string): Promise<number> {
  const started = performance.now()
  const proc = Bun.spawn([
    resolveViteRuntime(), join(frontend, 'node_modules/vite/bin/vite.js'),
    'build', '--outDir', join(directory, mode), '--emptyOutDir',
  ], {
    cwd: frontend,
    env: { ...process.env, VITE_BUILD_ID: 'compiler-benchmark', LUMIVERSE_REACT_COMPILER: mode, NO_COLOR: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  const seconds = (performance.now() - started) / 1000
  const log = `${stdout}\n${stderr}`
  writeFileSync(join(directory, `${mode}-${label}.log`), log)
  if (code !== 0) throw new Error(`${mode} build failed (${code}):\n${log}`)
  if (log.includes('Set `output.codeSplitting.groups[')) throw new Error('Missing chunk timing label')
  console.log(`${mode} ${label}: ${seconds.toFixed(2)}s`)
  return seconds
}

function javascriptSizes(dir: string): { bytes: number; gzipBytes: number; files: number } {
  const total = { bytes: 0, gzipBytes: 0, files: 0 }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const child = javascriptSizes(path)
      total.bytes += child.bytes
      total.gzipBytes += child.gzipBytes
      total.files += child.files
    } else if (entry.name.endsWith('.js')) {
      const contents = readFileSync(path)
      total.bytes += contents.length
      total.gzipBytes += gzipSync(contents).length
      total.files++
    }
  }
  return total
}

for (const mode of modes) await run(mode, 'warmup')
for (let round = 0; round < 3; round++) {
  const order = round % 2 ? [...modes].reverse() : modes
  for (const mode of order) samples[mode].push(await run(mode, `sample-${round + 1}`))
}
const summary = Object.fromEntries(modes.map((mode) => [mode, {
  seconds: samples[mode],
  medianSeconds: [...samples[mode]].sort((a, b) => a - b)[1],
  javascript: javascriptSizes(join(directory, mode)),
}]))
const result = {
  environment: { platform: process.platform, architecture: process.arch, bun: Bun.version, viteRuntime: resolveViteRuntime() },
  scope: 'Production app + PWA; one warm-up per mode; three measured builds each; excludes generation and type checking',
  ...summary,
}
writeFileSync(join(directory, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
