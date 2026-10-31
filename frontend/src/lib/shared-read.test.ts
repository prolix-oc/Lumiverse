import { beforeEach, expect, test } from 'bun:test'
import { invalidateSharedReads, resetAccountReads, shareRead } from './shared-read'

beforeEach(invalidateSharedReads)

test('concurrent readers share work and receive independent mutable documents', async () => {
  let calls = 0
  const read = async () => { calls++; return { blocks: [{ enabled: true }] } }
  const [a, b] = await Promise.all([shareRead('preset', read), shareRead('preset', read)])
  expect(calls).toBe(1)
  a.blocks[0].enabled = false
  expect(b.blocks[0].enabled).toBe(true)
  await shareRead('preset', read)
  expect(calls).toBe(2) // Completed values never become a freshness cache.
})

test.each([invalidateSharedReads, resetAccountReads])('an invalidation cannot join or release a newer read', async invalidate => {
  let release!: (value: string) => void
  const old = shareRead('settings', () => new Promise<string>(resolve => { release = resolve }))
  await Promise.resolve()
  invalidate()
  let releaseNew!: (value: string) => void
  let calls = 0
  const read = () => { calls++; return new Promise<string>(resolve => { releaseNew = resolve }) }
  const next = shareRead('settings', read)
  await Promise.resolve()
  release('old account or dataset')
  await old
  const joined = shareRead('settings', read)
  releaseNew('fresh')
  expect(await next).toBe('fresh')
  expect(await joined).toBe('fresh')
  expect(calls).toBe(1)
})

test('failures release the flight, including synchronous failures', async () => {
  await expect(shareRead('failure', () => { throw new Error('offline') })).rejects.toThrow('offline')
  expect(await shareRead('failure', async () => 'recovered')).toBe('recovered')
})
