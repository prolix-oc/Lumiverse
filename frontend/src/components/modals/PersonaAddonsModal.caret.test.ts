import { expect, test } from 'bun:test'

test('Persona add-on autosave caret regression passes in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/modals/PersonaAddonsModal.caret.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const watchdog = setTimeout(() => child.kill(9), 10_000)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = `${stdout}\n${stderr}`
    if (exitCode !== 0) {
      throw new Error(`Isolated Persona add-on caret test failed with exit code ${exitCode}:\n${output}`)
    }

    expect(exitCode).toBe(0)
    expect(output).toContain('1 pass')
    expect(output).toContain('0 fail')
  } finally {
    clearTimeout(watchdog)
  }
}, 11_000)
