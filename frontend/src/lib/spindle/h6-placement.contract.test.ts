import { expect, test } from 'bun:test'

test('H6 placement contract runs in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/h6-placement.contract.isolated.ts',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const summary = `${stdout}\n${stderr}`
  expect(exitCode, summary).toBe(0)
  expect(summary).toMatch(/Ran 30 tests across 1 file/)
  expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
})
