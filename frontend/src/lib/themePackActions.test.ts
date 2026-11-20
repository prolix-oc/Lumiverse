import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createThemePackActions } from './themePackActions'
import type { ThemePack } from './themePack'
import { DEFAULT_THEME } from '../theme/presets'

// Real schema fields, including all three layers and a portable asset.
const fixture: ThemePack = {
  format: 2,
  name: 'Bundle fixture',
  author: '',
  description: '',
  createdAt: 1,
  bundleId: 'original-bundle',
  theme: { ...DEFAULT_THEME, name: 'Bundle fixture' },
  globalCSS: '.wallpaper { background-image: url("assets/pixel.png"); }',
  components: {
    ChatMessage: { css: '.message { border-radius: 12px; }', tsx: '', enabled: true },
    ChatHeader: { css: '', tsx: 'export default function Header() { return <div>Hello</div> }', enabled: true },
  },
  assets: [{
    slug: 'pixel.png',
    originalFilename: 'pixel.png',
    mimeType: 'image/png',
    tags: ['background'],
    metadata: { label: 'Pixel' },
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
  }],
}

type InputMock = {
  type: string
  accept: string
  value: string
  files: File[]
  onchange: () => Promise<void>
  addEventListener: (event: string, handler: () => void) => void
  click: () => void
}

let selectedFile: File | null
let inputs: InputMock[]
let downloads: Array<{ filename: string; blob: Blob }>
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalCreateURL = URL.createObjectURL
const originalRevokeURL = URL.revokeObjectURL

beforeEach(() => {
  selectedFile = null
  inputs = []
  downloads = []
  const blobs = new Map<string, Blob>()
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:unit-test-${blobs.size}`
    blobs.set(url, blob)
    return url
  }
  URL.revokeObjectURL = () => {}
  // Minimal in-memory DOM boundary. No browser, rendering, or server involved.
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: { appendChild() {}, removeChild() {} },
    createElement(tag: string) {
      if (tag === 'a') {
        return { href: '', download: '', click() {
          downloads.push({ filename: this.download, blob: blobs.get(this.href)! })
        } }
      }
      if (tag !== 'input') throw new Error(`Unexpected element: ${tag}`)
      let cancel = () => {}
      const input: InputMock = {
        type: '', accept: '', value: 'selected-file', files: selectedFile ? [selectedFile] : [],
        onchange: async () => {},
        addEventListener(event, handler) { if (event === 'cancel') cancel = handler },
        click() { if (selectedFile) void input.onchange(); else cancel() },
      }
      inputs.push(input)
      return input
    },
  } })
})

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  URL.createObjectURL = originalCreateURL
  URL.revokeObjectURL = originalRevokeURL
})

function setup(stateOverrides: Partial<Parameters<typeof createThemePackActions>[0]> = {}) {
  const applied: ThemePack[] = []
  const asset = fixture.assets[0]
  const services: Parameters<typeof createThemePackActions>[1] = {
    t: ((key: string, options?: unknown) => `${key}${options ? JSON.stringify(options) : ''}`) as Parameters<typeof createThemePackActions>[1]['t'],
    themeAssetsApi: {
      list: mock(async () => [{
        id: 'asset-id', bundle_id: fixture.bundleId, slug: asset.slug,
        original_filename: asset.originalFilename, mime_type: asset.mimeType,
        tags: asset.tags, metadata: asset.metadata,
      }] as Awaited<ReturnType<Parameters<typeof createThemePackActions>[1]['themeAssetsApi']['list']>>),
      getBlob: mock(async () => new Blob([Uint8Array.from(atob(asset.dataBase64), c => c.charCodeAt(0))])),
      upload: mock(async () => ({} as Awaited<ReturnType<Parameters<typeof createThemePackActions>[1]['themeAssetsApi']['upload']>>)),
    },
    toast: { success: mock(() => ''), info: mock(() => ''), error: mock(() => '') },
  }
  const addSavedTheme = mock((input: Parameters<Parameters<typeof createThemePackActions>[0]['addSavedTheme']>[0]) => ({ ...input, id: 'saved', createdAt: 1 }))
  const actions = createThemePackActions({
    theme: fixture.theme,
    customCSS: { css: fixture.globalCSS, enabled: true, revision: 1, bundleId: fixture.bundleId },
    componentOverrides: fixture.components,
    savedThemes: [],
    applyThemePack: pack => { applied.push(pack) },
    addSavedTheme,
    ...stateOverrides,
  }, services)
  return { ...actions, applied, addSavedTheme, ...services }
}

describe('shared LumiTheme entry points', () => {
  test('Settings and Theme Editor bind both buttons to the same shared hook', () => {
    for (const path of ['../components/panels/ThemePanel.tsx', '../components/modals/CustomCSSModal.tsx']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(source).toContain("import { useThemePackActions } from '@/hooks/useThemePackActions'")
      expect(source).toContain('const { handleExportPack, handleImportPack } = useThemePackActions()')
      expect(source).toMatch(/onClick=\{(?:handleExportPack|\(\) => \{ void handleExportPack\(\) \})\}/)
      expect(source).toMatch(/onClick=\{(?:handleImportPack|\(\) => \{ void handleImportPack\(\) \})\}/)
      expect(source).not.toContain('createThemePack(')
      expect(source).not.toContain('applyThemePack(')
    }
    const settings = readFileSync(new URL('../components/panels/ThemePanel.tsx', import.meta.url), 'utf8')
    expect(settings).not.toContain('JSON.stringify')
    expect(settings).not.toContain('JSON.parse')
    expect(settings).not.toContain('createElement')
    const hook = readFileSync(new URL('../hooks/useThemePackActions.ts', import.meta.url), 'utf8')
    expect(hook).toContain('createThemePackActions(')
    expect(hook).toContain("useTranslation('modals', { keyPrefix: 'customCss' })")
  })

  test('exports the active My Themes display name instead of the stale preset name', async () => {
    const staleTheme = { ...fixture.theme!, id: 'slate', name: 'Slate' }
    const stalePack = { ...fixture, name: 'Slate', theme: staleTheme }
    const io = setup({
      theme: staleTheme,
      savedThemes: [{
        kind: 'pack',
        id: 'saved-starry',
        name: 'Starry Elegance',
        createdAt: 1,
        pack: stalePack,
      }],
    })

    await io.handleExportPack()

    expect(downloads).toHaveLength(1)
    expect(downloads[0].filename).toBe('starry-elegance.lumitheme')
    const archive = unzipSync(new Uint8Array(await downloads[0].blob.arrayBuffer()))
    const manifest = JSON.parse(strFromU8(archive['theme.json']))
    expect(manifest.name).toBe('Starry Elegance')
    expect(manifest.theme.name).toBe('Starry Elegance')

    selectedFile = new File([downloads[0].blob], downloads[0].filename, { type: 'application/zip' })
    await io.handleImportPack()
    expect(io.addSavedTheme).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'pack',
      name: 'Starry Elegance',
      pack: expect.objectContaining({
        name: 'Starry Elegance',
        theme: expect.objectContaining({ name: 'Starry Elegance' }),
      }),
    }))
  })

  test('canonical archive round-trip preserves CSS, overrides and assets, and disables imported TSX', async () => {
    const io = setup()
    await io.handleExportPack()
    expect(downloads).toHaveLength(1)
    expect(downloads[0].filename).toBe('bundle-fixture.lumitheme')
    expect(downloads[0].blob.type).toBe('application/zip')
    const archive = unzipSync(new Uint8Array(await downloads[0].blob.arrayBuffer()))
    const manifest = JSON.parse(strFromU8(archive['theme.json']))
    expect(manifest.format).toBe(3)
    expect(manifest.globalCSS).toBe(fixture.globalCSS)
    expect(manifest.components).toEqual(fixture.components)
    expect(manifest.assets[0].archivePath).toBe('assets/001-pixel.png')
    expect(io.themeAssetsApi.list).toHaveBeenCalledWith(fixture.bundleId)
    expect(io.themeAssetsApi.getBlob).toHaveBeenCalledWith('asset-id')

    selectedFile = new File([downloads[0].blob], downloads[0].filename, { type: 'application/zip' })
    await io.handleImportPack()
    const pack = io.applied[0]
    expect(pack.theme).toEqual(fixture.theme)
    expect(pack.globalCSS).toBe(fixture.globalCSS)
    expect(pack.assets).toEqual(fixture.assets)
    expect(pack.components.ChatMessage).toEqual(fixture.components.ChatMessage)
    expect(pack.components.ChatHeader).toEqual({ ...fixture.components.ChatHeader, enabled: false })
    expect(pack.bundleId).not.toBe(fixture.bundleId)
    expect(io.themeAssetsApi.upload).toHaveBeenCalledWith(expect.any(File), {
      bundleId: pack.bundleId, slug: 'pixel.png', tags: ['background'], metadata: { label: 'Pixel' },
    })
    expect(io.addSavedTheme).toHaveBeenCalledWith({ kind: 'pack', name: fixture.name, pack })
    expect(io.toast.success).toHaveBeenLastCalledWith(expect.stringContaining('tsxDisabledNote'))
    expect(inputs[0].accept).toBe('.lumitheme,.lumiverse-theme,.json,.zip,application/zip')
    expect(inputs[0].value).toBe('')

    await io.handleImportPack()
    expect(io.applied).toHaveLength(2)
    expect(io.applied[1].bundleId).not.toBe(pack.bundleId)
    expect(inputs[1].value).toBe('')
  })

  test.each(['success', 'failure'])('Android theme exports await native publication: %s', async (outcome) => {
    let finish!: () => void
    let fail!: (error: Error) => void
    const completion = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    const saveBlob = mock((_blob: Blob, _filename: string) => completion)
    const saveUrl = mock(async () => {})
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      lumiverseNativeDownloads: { saveBlob, saveUrl },
    } })
    const io = setup()
    let completed = false
    const exporting = io.handleExportPack().then(() => { completed = true })
    // Allow asset loading/encoding to finish while the native save stays pending.
    await Bun.sleep(0)
    expect(saveBlob).toHaveBeenCalledTimes(1)
    expect(saveUrl).not.toHaveBeenCalled()
    expect(downloads).toHaveLength(0)
    expect(completed).toBe(false)
    expect(io.toast.success).not.toHaveBeenCalled()
    const [blob, filename] = saveBlob.mock.calls[0]
    expect(filename).toBe('bundle-fixture.lumitheme')
    expect(blob.type).toBe('application/zip')
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    const manifest = JSON.parse(strFromU8(archive['theme.json']))
    expect(manifest.name).toBe(fixture.name)
    expect(manifest.globalCSS).toBe(fixture.globalCSS)
    expect(manifest.components).toEqual(fixture.components)
    expect(archive['assets/001-pixel.png']).toEqual(Uint8Array.from(atob(fixture.assets[0].dataBase64), c => c.charCodeAt(0)))

    if (outcome === 'success') finish()
    else fail(new Error('Storage full'))
    await exporting
    if (outcome === 'success') {
      expect(io.toast.success).toHaveBeenCalledWith('exportSuccess')
      expect(io.toast.error).not.toHaveBeenCalled()
    } else {
      expect(io.toast.error).toHaveBeenCalledWith('Storage full')
      expect(io.toast.success).not.toHaveBeenCalled()
    }
  })

  test.each([1, 2])('retains canonical legacy version %i support', async format => {
    const io = setup()
    selectedFile = new File([JSON.stringify({ ...fixture, format })], 'legacy.lumiverse-theme')
    await io.handleImportPack()
    expect(io.applied[0].globalCSS).toBe(fixture.globalCSS)
    expect(io.applied[0].format).toBe(2)
    expect(io.applied[0].components.ChatHeader.enabled).toBe(false)
  })

  test.each([
    ['invalid JSON', new File(['{'], 'invalid.json'), 'could not be parsed'],
    ['old partial settings', new File([JSON.stringify(DEFAULT_THEME)], 'theme.json'), 'not a supported'],
    ['unknown legacy version', new File([JSON.stringify({ ...fixture, format: 99 })], 'theme.json'), 'not a supported'],
    ['missing manifest', new File([Uint8Array.from(zipSync({ 'other.txt': strToU8('x') }))], 'theme.lumitheme'), 'missing theme.json'],
    ['unknown archive version', new File([Uint8Array.from(zipSync({ 'theme.json': strToU8(JSON.stringify({ ...fixture, format: 99 })) }))], 'theme.lumitheme'), 'required theme bundle fields'],
    ['unsafe path', new File([Uint8Array.from(zipSync({ 'theme.json': strToU8('{}'), '../escape': strToU8('x') }))], 'theme.lumitheme'), 'unsafe file path'],
  ])('shared import rejects %s before application', async (_label, file, message) => {
    const io = setup()
    selectedFile = file as File
    await io.handleImportPack()
    expect(io.toast.error).toHaveBeenCalledWith(expect.stringContaining(message as string))
    expect(io.applied).toHaveLength(0)
    expect(io.addSavedTheme).not.toHaveBeenCalled()
    expect(io.themeAssetsApi.upload).not.toHaveBeenCalled()
    expect(inputs[0].value).toBe('')
  })

  test('keeps cancellation and asset failure notifications without applying or saving', async () => {
    const io = setup()
    await io.handleImportPack()
    expect(io.toast.info).toHaveBeenCalledWith('importCancelled')
    selectedFile = new File([JSON.stringify(fixture)], 'theme.json')
    io.themeAssetsApi.upload = mock(async () => { throw new Error('Upload failed') })
    await io.handleImportPack()
    expect(io.toast.error).toHaveBeenCalledWith('Upload failed')
    expect(io.applied).toHaveLength(0)
    expect(io.addSavedTheme).not.toHaveBeenCalled()
  })

  test('keeps export failures in the existing error presentation', async () => {
    const io = setup()
    io.themeAssetsApi.list = mock(async () => { throw new Error('Asset listing failed') })
    await io.handleExportPack()
    expect(io.toast.error).toHaveBeenCalledWith('Asset listing failed')
    expect(downloads).toHaveLength(0)
  })
})
