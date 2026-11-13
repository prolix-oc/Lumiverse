import { expect, test } from 'bun:test'

// This suite loads the production Loom component graph with process-global Bun
// module mocks. Keep it isolated from neighboring suites in one Bun process.
test('real Loom bridge integration passes in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/components-helper.real-loom.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, 15_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const summary = `${stdout}\n${stderr}`
    if (timedOut) {
      throw new Error(`Isolated real Loom bridge tests timed out:\n${summary}`)
    }
    if (exitCode !== 0) {
      throw new Error(`Isolated real Loom bridge tests failed with exit code ${exitCode}:\n${summary}`)
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
}, 20_000)
