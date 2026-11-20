import { beforeEach, expect, mock, test } from 'bun:test'
import { invalidateSharedReads } from '@/lib/shared-read'

const reads: Array<{ path: string; params: any }> = []
mock.module('./client', () => ({
  BASE_URL: '/api/v1', post: async () => {}, put: async () => {}, del: async () => {},
  get: async (path: string, params: any) => {
    reads.push({ path, params })
    if (path === '/presets/registry') {
      const all = Array.from({ length: 451 }, (_, id) => ({ id: String(id), name: `Preset ${id}` }))
      return { data: all.slice(params.offset, params.offset + params.limit), total: all.length, limit: params.limit, offset: params.offset }
    }
    return { id: 'p', prompt_order: [{ id: 'block', enabled: true }] }
  },
}))
const { presetsApi } = await import('./presets')
beforeEach(() => { reads.length = 0; invalidateSharedReads() })

test('shared registry loading covers every page above the server limit', async () => {
  const [a, b] = await Promise.all([presetsApi.listRegistryAll({ provider: 'loom' }), presetsApi.listRegistryAll({ provider: 'loom' })])
  expect(a.data).toHaveLength(451)
  expect(b.data[450].id).toBe('450')
  expect(reads.map(read => read.params.offset)).toEqual([0, 200, 400])
})

test('preset editor consumers share a pending read but cannot mutate each other', async () => {
  const [a, b] = await Promise.all([presetsApi.get('p'), presetsApi.get('p')])
  a.prompt_order[0].enabled = false
  expect(b.prompt_order[0].enabled).toBe(true)
  expect(reads).toHaveLength(1)
  invalidateSharedReads()
  await presetsApi.get('p')
  expect(reads).toHaveLength(2)
})
