import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { frontendStaticRoutes } from './frontend-static'

const root = mkdtempSync(join(tmpdir(), 'frontend-static-'))
mkdirSync(join(root, 'assets'))
for (const [path, body] of Object.entries({
  'index.html': '<html>app</html>', 'sw.js': 'self.skipWaiting()',
  'assets/main-Abc12_-D.js': 'export {}', 'assets/theme-reference-index.json': '{}',
})) writeFileSync(join(root, path), body)
const app = new Hono().route('/', frontendStaticRoutes(root))
app.notFound(c => c.json({ error: 'Not found' }, 404))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test.each(['/assets/missing-12345678.js', '/sw-missing.js', '/api/missing', '/importmap.json'])('returns a real 404 for %s', async path => {
  const response = await app.request(path)
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('<html>')
  expect(response.headers.get('Cache-Control') ?? '').not.toContain('immutable')
})

test('serves SPA routes with revalidation', async () => {
  const response = await app.request('/chat/example')
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('<html>')
  expect(response.headers.get('Cache-Control')).toBe('no-cache')
})

test('revalidates mutable asset pointers and the worker', async () => {
  for (const path of ['/assets/theme-reference-index.json', '/sw.js']) {
    const response = await app.request(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
  }
  expect((await app.request('/sw.js')).headers.get('Service-Worker-Allowed')).toBe('/')
})

test('keeps successful hashed chunks immutable', async () => {
  const response = await app.request('/assets/main-Abc12_-D.js')
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toContain('immutable')
})
