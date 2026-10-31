import { expect, test } from 'bun:test'
import { lazyWithPreload } from './lazy-with-preload'

test('concurrent and later preloads share one import without mounting a panel', async () => {
  let imports = 0
  let mounts = 0
  let finish!: (module: { default: () => null }) => void
  const module = { default: () => { mounts += 1; return null } }
  const panel = lazyWithPreload(() => { imports += 1; return new Promise<typeof module>(resolve => { finish = resolve }) })
  const first = panel.preload()
  const second = panel.preload()
  expect(first).toBe(second)
  expect(imports).toBe(1)
  finish(module)
  await first
  expect(await panel.preload()).toBe(module)
  expect(imports).toBe(1)
  expect(mounts).toBe(0)
})

test('a failed speculative import can be retried on actual demand', async () => {
  let imports = 0
  const module = { default: () => null }
  const panel = lazyWithPreload(() => ++imports === 1
    ? Promise.reject(new Error('Temporary chunk failure')) : Promise.resolve(module))
  await expect(panel.preload()).rejects.toThrow('Temporary chunk failure')
  expect(await panel.preload()).toBe(module)
  expect(imports).toBe(2)
})
