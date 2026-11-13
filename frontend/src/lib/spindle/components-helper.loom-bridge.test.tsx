import { expect, test } from 'bun:test'

// This suite installs process-global Bun module mocks. Keep it isolated from
// neighboring suites when Bun runs the focused command in one process.
test('Loom bridge cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/components-helper.loom-bridge.isolated.tsx',
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
    const summary = `${stdout}\n${stderr}`
    if (timedOut) {
      throw new Error(`Isolated Loom bridge tests timed out:\n${summary}`)
    }
    if (exitCode !== 0) {
      throw new Error(`Isolated Loom bridge tests failed with exit code ${exitCode}:\n${summary}`)
    }
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(summary).toMatch(/\b[1-9]\d* pass\b/)
    expect(summary).toMatch(/\b0 fail\b/)
    expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
    expect(summary).toMatch(/Ran [1-9]\d* tests? across 1 file/)
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)
