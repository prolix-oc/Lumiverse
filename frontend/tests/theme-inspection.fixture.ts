import { createThemeAuthoringAPI } from '../src/lib/spindle/theme-authoring'
import { inspectThemeElements } from '../src/lib/spindle/theme-inspection'
import { createThemePack, encodeThemePackArchive, decodeThemePackArchive, restoreThemePackComponents } from '../src/lib/themePack'

let active = true
let allowed = true
const api = createThemeAuthoringAPI({
  assertActive() { if (!active) throw new Error('Disposed') },
  requireAppManipulation() { if (!allowed) throw new Error('Permission denied') },
  inspect: inspectThemeElements,
} as Parameters<typeof createThemeAuthoringAPI>[0])

Object.assign(window, { themeInspectionFixture: {
  api,
  roundTrip() {
    const component = { css: '.root{color:red}', tsx: 'export default () => <div />', enabled: true }
    const pack = createThemePack(null, { css: 'body{color:red}', enabled: false, revision: 0, bundleId: null },
      { Test: component }, [{ slug: 'assets/font.ttf', originalFilename: 'font.ttf', mimeType: 'font/ttf',
        tags: [], metadata: {}, dataBase64: 'AAEC' }], { name: 'Browser theme' })
    const decoded = decodeThemePackArchive(encodeThemePackArchive(pack))
    if (decoded.error) throw new Error(decoded.error.message)
    return {
      pack: decoded.pack,
      restored: restoreThemePackComponents(decoded.pack.components, { Test: { ...component, enabled: false } }),
    }
  },
  deny() { allowed = false },
  dispose() { active = false },
} })
