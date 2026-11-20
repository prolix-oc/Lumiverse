import { expect, test } from 'bun:test'

test('deferred placement lifecycle cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/spindle/spindle-placement.lifecycle.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // A real-clock watchdog is required because fake timers cannot terminate a child Bun process.
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, 14_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = `${stdout}\n${stderr}`
    if (timedOut) {
      throw new Error(`Isolated deferred placement tests timed out after 14_000 ms:\n${output}`)
    }
    if (exitCode !== 0) {
      throw new Error(`Isolated deferred placement tests failed with exit code ${exitCode}:\n${output}`)
    }
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)
