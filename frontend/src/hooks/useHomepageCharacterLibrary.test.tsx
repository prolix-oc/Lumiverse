import { expect, test } from 'bun:test'

// This fixture installs process-global Bun module mocks. Keep it in a child
// process so those mocks and the JSDOM globals cannot leak into neighboring
// frontend test files.
test('homepage character library hook cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/hooks/useHomepageCharacterLibrary.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../..`,
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
    throw new Error(`Isolated homepage character library tests failed:\n${summary}`)
  }
  expect(timedOut).toBe(false)
  expect(exitCode).toBe(0)
  expect(summary).toMatch(/\b5 pass\b/)
  expect(summary).toMatch(/\b0 fail\b/)
  expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
  expect(summary).toMatch(/Ran 5 tests across 1 file/)
}, 15_000)
