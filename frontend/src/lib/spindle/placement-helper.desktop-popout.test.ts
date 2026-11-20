import { expect, test } from 'bun:test'

// The isolated companion reads the desktop pop-out target from module-load
// globals, so it needs a module graph of its own.
test('desktop pop-out placement contract runs in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/placement-helper.desktop-popout.isolated.ts',
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
  expect(summary).toMatch(/Ran 2 tests across 1 file/)
  expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
})
