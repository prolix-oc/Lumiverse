import { expect, test } from 'bun:test'

// This suite installs process-global Bun module mocks. Keep it isolated from
// neighboring suites when Bun runs the focused command in one process.
test('component helper cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/components-helper.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, 10_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = `${stdout}\n${stderr}`
    const diagnostics = [
      `child exit code: ${exitCode}`,
      `child timed out: ${timedOut}`,
      'child stdout:',
      stdout,
      'child stderr:',
      stderr,
    ].join('\n')
    try {
      expect(timedOut).toBe(false)
      expect(exitCode).toBe(0)
      const summaryLines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+ (?:pass|fail|skip)$/.test(line))
      expect(summaryLines).toEqual(['29 pass', '0 fail'])
      expect(output).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
      expect(output).toMatch(/Ran 29 tests across 1 file/)
    } catch (error) {
      throw new Error(
        `Isolated component helper tests failed:\n${diagnostics}\n${String(error)}`,
      )
    }
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)
