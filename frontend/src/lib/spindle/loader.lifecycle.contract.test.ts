import { expect, test } from 'bun:test'

// The contract fixture installs process-global module mocks. Run it in a child
// process so Bun's parent discovery process cannot retain those mocks or cache.
test('loader lifecycle contract cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/loader.lifecycle.contract.isolated.ts',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  // A real watchdog is required here because the child can deadlock before
  // emitting a completion signal; fake time cannot observe that process state.
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
    throw new Error(`Isolated lifecycle contract tests failed:\n${summary}`)
  }
  expect(timedOut).toBe(false)
  expect(exitCode).toBe(0)
  expect(summary).toMatch(/\b24 pass\b/)
  expect(summary).toMatch(/\b0 fail\b/)
  expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
  expect(summary).toMatch(/Ran 24 tests across 1 file/)
}, 15_000)
