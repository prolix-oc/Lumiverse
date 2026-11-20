import { expect, test } from 'bun:test'

test('connection recording lifecycle passes in an isolated module graph', async () => {
  const child = Bun.spawn([process.execPath, 'test', './src/lib/sttEngine.lifecycle.isolated.ts'], {
    cwd: `${import.meta.dir}/../..`, stdout: 'pipe', stderr: 'pipe',
  })
  const watchdog = setTimeout(() => child.kill(), 10_000)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(watchdog)
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  expect(code).toBe(0); expect(`${stdout}\n${stderr}`).toMatch(/2 pass/)
}, 15_000)
