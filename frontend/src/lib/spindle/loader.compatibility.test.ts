import { expect, test } from 'bun:test'

test('frontend loader compatibility cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/loader.compatibility.isolated.ts',
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
    const summaryLines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+ (?:pass|fail|skip)$/.test(line))
    try {
      expect(exitCode).toBe(0)
      expect(summaryLines).toEqual(['7 pass', '0 fail'])
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Isolated loader compatibility tests failed (${detail}):\n${output}`)
    }
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)
