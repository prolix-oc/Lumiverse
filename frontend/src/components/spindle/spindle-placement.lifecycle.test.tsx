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
    const summaryLines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+ (?:pass|fail|skip)$/.test(line))
    const expectedSummary = ['5 pass', '0 fail']
    if (timedOut) {
      throw new Error(`Isolated deferred placement tests timed out after 14_000 ms:\n${output}`)
    }
    if (exitCode !== 0) {
      throw new Error(`Isolated deferred placement tests failed with exit code ${exitCode}:\n${output}`)
    }
    if (summaryLines.length !== expectedSummary.length || summaryLines.some((line, index) => line !== expectedSummary[index])) {
      throw new Error(`Isolated deferred placement tests reported unexpected counts: ${summaryLines.join(', ')}\n${output}`)
    }
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(summaryLines).toEqual(expectedSummary)
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)
