import { expect, test } from 'bun:test'

test('Agentic Runtime panel passes in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/panels/AgenticRuntimePanel.isolated.tsx',
  ], {
    cwd: import.meta.dir.replace(/\/src\/components\/panels$/, ''),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const watchdog = setTimeout(() => child.kill(), 20_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(watchdog)
  const summary = `${stdout}\n${stderr}`
  expect(exitCode).toBe(0)
  expect(summary).toMatch(/\b[1-9]\d* pass\b/)
  expect(summary).toMatch(/\b0 fail\b/)
})
