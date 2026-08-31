import { expect, test } from 'bun:test'

// Agent activity exercises the real Zustand store and installs browser/module
// seams. Keep it in a child process so another focused fixture cannot replace
// the store module before this test imports the component.
test('agent activity cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/chat/AgentRunActivity.isolated.tsx',
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
    throw new Error(`Isolated agent activity tests failed:\n${summary}`)
  }
  expect(timedOut).toBe(false)
  expect(exitCode).toBe(0)
  expect(summary).toMatch(/\b16 pass\b/)
  expect(summary).toMatch(/\b0 fail\b/)
  expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
  expect(summary).toMatch(/Ran 16 tests across 1 file/)
}, 15_000)
