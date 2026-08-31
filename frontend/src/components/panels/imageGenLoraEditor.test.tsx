import { expect, test } from 'bun:test'

// The LoRA editor fixture replaces i18n, store, provider, and DnD modules.
// Keep those focused mocks out of the shared frontend test process.
test('image LoRA editor cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/panels/imageGenLoraEditor.isolated.tsx',
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
