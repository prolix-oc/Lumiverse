import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

// Bun's module mocks persist between test files. Keep command-registry mocks in
// their own process so this integration test cannot replace real command tests.
if (process.env.LUMIVERSE_KEYBINDING_HOOK_TEST === '1') {
  await import('../../test-fixtures/desktop-keybindings')
} else {
  test('desktop key binding hook integration', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, LUMIVERSE_KEYBINDING_HOOK_TEST: '1' },
    })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ exit, output: exit ? stdout + stderr : '' }).toEqual({ exit: 0, output: '' })
  })
}
