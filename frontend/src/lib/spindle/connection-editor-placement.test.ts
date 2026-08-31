import { expect, test } from 'bun:test'

// Placement tests replace the store, component helper, and preset editor
// helper. Keep those focused exports from replacing the production modules.
test('connection editor placement cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/connection-editor-placement.isolated.ts',
  ], {
    cwd: `${import.meta.dir}/../../../`,
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
