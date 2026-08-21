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
