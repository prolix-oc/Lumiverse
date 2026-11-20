import { describe, expect, test } from 'bun:test'
const componentSource = await Bun.file(new URL('./WorldBookEditorModal.tsx', import.meta.url)).text()
const shellSource = await Bun.file(new URL('../shared/ModalShell.tsx', import.meta.url)).text()
describe('native World Book workspace', () => {
  test('fullscreen changes the same shell without an extension handoff', () => {
    expect(componentSource).toContain('fullscreen={workspace}')
    expect(componentSource).toContain('setFullscreen(current => !current)')
    expect(componentSource).not.toContain('launchLorebookEditor')
    expect(componentSource).not.toContain('enhanced full editor')
    expect(componentSource).toContain('const workspace = fullscreen || isMobile')
  })
  test('the fullscreen primitive omits desktop caps', () => {
    expect(shellSource).toContain("maxWidth: fullscreen ? 'none' :")
    expect(shellSource).toContain("maxHeight: fullscreen ? 'none' :")
  })
})
