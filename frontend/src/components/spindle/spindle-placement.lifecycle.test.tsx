import { expect, test } from 'bun:test'

test('deferred placement lifecycle cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/spindle/spindle-placement.lifecycle.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const watchdog = setTimeout(() => child.kill(9), 14_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = `${stdout}\n${stderr}`
    if (exitCode !== 0) {
      throw new Error(`Isolated deferred placement tests failed:\n${output}`)
    }
    expect(exitCode).toBe(0)
    const summaryLines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+ (?:pass|fail|skip)$/.test(line))
    expect(summaryLines).toEqual(['3 pass', '0 fail'])
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)
