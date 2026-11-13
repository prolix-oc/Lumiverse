import { describe, expect, test } from 'bun:test'

const settingsSource = await Bun.file(new URL('./SettingsModal.tsx', import.meta.url)).text()
const drawerSource = await Bun.file(new URL('../../lib/drawer-tab-registry.tsx', import.meta.url)).text()
const connectionFormSource = await Bun.file(new URL('../panels/embedding-connections/EmbeddingConnectionForm.tsx', import.meta.url)).text()

describe('dedicated embedding connections contract', () => {
  test('Embeddings selects only dedicated embedding profiles', () => {
    const start = settingsSource.indexOf('function EmbeddingsSettings()')
    const end = settingsSource.indexOf('function MemoryCortex', start)
    const embeddingsRegion = settingsSource.slice(start, end > start ? end : undefined)

    expect(embeddingsRegion).toContain('<EmbeddingConnectionPicker')
    expect(embeddingsRegion).not.toContain('useStore((s) => s.profiles)')
    expect(embeddingsRegion).not.toContain('<SidecarConnectionPicker')
    expect(embeddingsRegion).not.toContain('projectConnectionProfiles(')
  })

  test('Connections mounts a dedicated embedding manager', async () => {
    expect(drawerSource).toContain('<ConnectionsPanel />')
    const panel = await Bun.file(new URL('../panels/ConnectionsPanel.tsx', import.meta.url)).text()
    expect(panel).toContain("['embeddings', EmbeddingConnectionManager]")
    expect(panel).toContain('t(`connections.${key}`)')
    expect(panel).toContain('connections-stack')
  })

  test('offers native Mistral and Cohere connections with their API defaults', () => {
    expect(connectionFormSource).toContain("mistral: { api_url: 'https://api.mistral.ai/v1/embeddings', model: 'mistral-embed' }")
    expect(connectionFormSource).toContain("cohere: { api_url: 'https://api.cohere.com/v2/embed', model: 'embed-v4.0' }")
    expect(settingsSource).toContain('<option value="mistral">Mistral</option>')
    expect(settingsSource).toContain('<option value="cohere">Cohere</option>')
  })
})
