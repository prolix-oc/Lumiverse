import { describe, expect, test } from 'bun:test'
import { resolveDockPanelEdge } from './dock-placement'

describe('resolveDockPanelEdge', () => {
  test('uses the desktop preference for ordinary horizontal docks', () => {
    expect(resolveDockPanelEdge('right', 'left', false)).toBe('left')
    expect(resolveDockPanelEdge('left', 'right', false)).toBe('right')
  })

  test('preserves an explicitly requested desktop edge', () => {
    expect(resolveDockPanelEdge('right', 'left', false, true)).toBe('right')
    expect(resolveDockPanelEdge('left', 'right', false, true)).toBe('left')
  })

  test('keeps the mobile safety remap even when the requested edge is respected', () => {
    expect(resolveDockPanelEdge('right', 'left', true, true)).toBe('top')
    expect(resolveDockPanelEdge('left', 'right', true, true)).toBe('top')
  })

  test('leaves vertical edges unchanged', () => {
    expect(resolveDockPanelEdge('top', 'left', false, true)).toBe('top')
    expect(resolveDockPanelEdge('bottom', 'right', true, false)).toBe('bottom')
  })
})

describe('dock placement consumers', () => {
  test('layout, panel rendering and control labels all forward the requested-edge policy', async () => {
    const consumers = [
      ['../../App.tsx', 'p'],
      ['../../components/spindle/SpindleDockPanel.tsx', 'panel'],
      ['../../components/spindle/SpindleUIControlPanel.tsx', 'panel'],
    ] as const
    for (const [path, variable] of consumers) {
      const source = await Bun.file(new URL(path, import.meta.url)).text()
      const calls = [...source.matchAll(/resolveDockPanelEdge\(([^)]*)\)/g)]
      expect(calls.length).toBe(1)
      expect(calls[0][1].split(',').map((argument) => argument.trim()).filter(Boolean)).toEqual([
        variable + '.edge', 'dockPanelDesktopSide', 'isMobile', variable + '.respectRequestedEdge',
      ])
    }
  })
})
