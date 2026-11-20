import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('Vite materializes the native component catalog', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  try {
    const registryModule = await server.ssrLoadModule('/src/lib/cssModuleRegistry.ts') as {
      CSS_MODULE_REGISTRY: readonly unknown[]
    }
    expect(registryModule.CSS_MODULE_REGISTRY.length).toBeGreaterThan(100)
  } finally {
    await server.close()
  }
})
