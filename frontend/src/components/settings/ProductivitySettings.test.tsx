import { expect, test } from 'bun:test'

// Productivity settings uses a focused store and settings-slice mock. Keep
// those process-global module seams out of the shared frontend test runner.
test('productivity settings cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/settings/ProductivitySettings.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 10_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(watchdog)
  const summary = `${stdout}\n${stderr}`
  if (exitCode !== 0) {
    throw new Error(`Isolated productivity settings tests failed:\n${summary}`)
  }
  expect(timedOut).toBe(false)
  expect(exitCode).toBe(0)
  expect(summary).toMatch(/\b20 pass\b/)
  expect(summary).toMatch(/\b0 fail\b/)
  expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
  expect(summary).toMatch(/Ran 20 tests across 1 file/)
}, 15_000)
