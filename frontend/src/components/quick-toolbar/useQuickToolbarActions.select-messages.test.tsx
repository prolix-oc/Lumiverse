import { expect, test } from 'bun:test'

// The action catalog test replaces the store and registry seams before loading the
// real hook. Keep that graph out of the shared focused-test process: a neighboring
// composer test mocks this hook with a smaller return object.
test('select-messages toolbar cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/quick-toolbar/useQuickToolbarActions.select-messages.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 20_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(watchdog)
  const summary = `${stdout}\n${stderr}`
  expect(timedOut).toBe(false)
  expect(exitCode).toBe(0)
  expect(summary).toMatch(/\b[1-9]\d* pass\b/)
  expect(summary).toMatch(/\b0 fail\b/)
}, 25_000)
