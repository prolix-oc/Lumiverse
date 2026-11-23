import { describe, expect, test } from 'bun:test'
import type { DrawerLayoutItem } from '@/types/store'
import {
  applyDrawerSidebarDrop,
  canMergeDrawerSidebarTabs,
  constrainDrawerSidebarDrag,
  drawerSidebarDividerDropId,
  drawerSidebarDropSide,
} from './drawer-sidebar-drop'

const tab = (tabId: string): DrawerLayoutItem => ({ type: 'tab', tabId })
const layout = (): DrawerLayoutItem[] => [
  tab('profile'),
  { type: 'folder', id: 'tools', name: 'Tools', icon: 'game', children: ['regex', 'macro'] },
  tab('lorebook'),
  tab('spindle:extension:tab:panel'),
]

describe('sidebar-native folder gestures', () => {
  test('desktop drag stays on the vertical rail and cannot horizontally scroll the whole icon column', () => {
    const original = { x: 240, y: 76, scaleX: 1, scaleY: 1 }
    const vertical = constrainDrawerSidebarDrag(original, false)
    expect(vertical).toEqual({ x: 0, y: 76, scaleX: 1, scaleY: 1 })
    // Narrow desktop windows use the mobile CSS layout even with a mouse.
    const horizontal = constrainDrawerSidebarDrag(original, true)
    expect(horizontal).toEqual({ x: 240, y: 0, scaleX: 1, scaleY: 1 })
    expect(original).toEqual({ x: 240, y: 76, scaleX: 1, scaleY: 1 })
    expect(constrainDrawerSidebarDrag({ x: -90, y: -50 }, false)).toEqual({ x: 0, y: -50 })
  })

  test('geometry uses desktop vertical and mobile horizontal axes', () => {
    const rail = { top: 100, left: 20, width: 48, height: 48 }
    expect(drawerSidebarDropSide({ top: 103, left: 20, width: 48, height: 6 }, rail, false)).toBe('before')
    expect(drawerSidebarDropSide({ top: 117, left: 20, width: 48, height: 10 }, rail, false)).toBe('inside')
    expect(drawerSidebarDropSide({ top: 142, left: 20, width: 48, height: 8 }, rail, false)).toBe('after')
    expect(drawerSidebarDropSide({ top: 100, left: 21, width: 6, height: 48 }, rail, true)).toBe('before')
    expect(drawerSidebarDropSide({ top: 100, left: 41, width: 8, height: 48 }, rail, true)).toBe('inside')
    expect(drawerSidebarDropSide({ top: 100, left: 63, width: 8, height: 48 }, rail, true)).toBe('after')
    expect(drawerSidebarDropSide(null, rail, true)).toBe('inside')
    expect(drawerSidebarDropSide(rail, null, false)).toBe('inside')
  })

  test('quick overlap reorders; a committed dwell creates a folder instead', () => {
    const source = [tab('a'), tab('b'), tab('c')]
    expect(applyDrawerSidebarDrop(source, 'tab:a', 'tab:c', 'inside', false))
      .toEqual([tab('b'), tab('c'), tab('a')])
    const merged = applyDrawerSidebarDrop(source, 'tab:a', 'tab:c', 'inside', true)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(tab('b'))
    expect(merged[1]).toMatchObject({ type: 'folder', children: ['c', 'a'] })
    expect(source).toHaveLength(3)
  })

  test('drop onto an existing folder to add, or onto an expanded child to reorder', () => {
    expect(applyDrawerSidebarDrop(layout(), 'tab:profile', 'folder:tools', 'inside'))
      .toEqual([
        { type: 'folder', id: 'tools', name: 'Tools', icon: 'game', children: ['regex', 'macro', 'profile'] },
        tab('lorebook'), tab('spindle:extension:tab:panel'),
      ])
    expect(applyDrawerSidebarDrop(layout(), 'tab:lorebook', 'tab:macro', 'inside'))
      .toEqual([
        tab('profile'),
        { type: 'folder', id: 'tools', name: 'Tools', icon: 'game', children: ['regex', 'lorebook', 'macro'] },
        tab('spindle:extension:tab:panel'),
      ])
  })

  test('a child can leave a folder ABOVE it, BELOW it or at root end', () => {
    const source = layout()
    const before = applyDrawerSidebarDrop(source, 'tab:regex', 'folder:tools', 'before')
    expect(before.slice(0, 3)).toEqual([
      tab('profile'), tab('regex'),
      { type: 'folder', id: 'tools', name: 'Tools', icon: 'game', children: ['macro'] },
    ])
    const after = applyDrawerSidebarDrop(source, 'tab:regex', 'folder:tools', 'after')
    expect(after.slice(0, 3)).toEqual([
      tab('profile'),
      { type: 'folder', id: 'tools', name: 'Tools', icon: 'game', children: ['macro'] },
      tab('regex'),
    ])
    expect(applyDrawerSidebarDrop(source, 'tab:macro', 'drawer-layout:root-end', 'inside').at(-1))
      .toEqual(tab('macro'))
  })

  test('a last, expanded folder has separate inside and outside destinations', () => {
    const endFolder: DrawerLayoutItem[] = [
      tab('profile'),
      { type: 'folder', id: 'end', name: 'At the bottom', icon: 'folder', children: ['a', 'b'] },
    ]
    const inside = applyDrawerSidebarDrop(endFolder, 'tab:profile', 'folder:end', 'inside')
    expect(inside).toEqual([
      { type: 'folder', id: 'end', name: 'At the bottom', icon: 'folder', children: ['a', 'b', 'profile'] },
    ])
    const outside = applyDrawerSidebarDrop(endFolder, 'tab:a', 'drawer-layout:root-end', 'inside')
    expect(outside).toEqual([
      tab('profile'),
      { type: 'folder', id: 'end', name: 'At the bottom', icon: 'folder', children: ['b'] },
      tab('a'),
    ])
    expect(endFolder[1]).toMatchObject({ type: 'folder', children: ['a', 'b'] })
  })

  test('divider halves preserve a precise boundary even immediately after an expanded folder', () => {
    const source: DrawerLayoutItem[] = [
      tab('profile'),
      { type: 'folder', id: 'end', name: 'End group', icon: 'folder', children: ['a', 'b'] },
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      tab('connections'),
    ]
    const before = applyDrawerSidebarDrop(source, 'tab:b', drawerSidebarDividerDropId('extensions', 'before'), 'inside')
    expect(before).toEqual([
      tab('profile'),
      { type: 'folder', id: 'end', name: 'End group', icon: 'folder', children: ['a'] },
      tab('b'),
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      tab('connections'),
    ])
    const after = applyDrawerSidebarDrop(source, 'tab:b', drawerSidebarDividerDropId('extensions', 'after'), 'before')
    expect(after).toEqual([
      tab('profile'),
      { type: 'folder', id: 'end', name: 'End group', icon: 'folder', children: ['a'] },
      { type: 'divider', id: 'extensions', label: 'Extensions' },
      tab('b'),
      tab('connections'),
    ])
    // Explicit half wins over accidental geometry-derived 'inside' or 'before'.
    expect(applyDrawerSidebarDrop(source, 'tab:connections', drawerSidebarDividerDropId('extensions', 'before'), 'inside')[2])
      .toEqual(tab('connections'))
    expect(source[1]).toMatchObject({ type: 'folder', children: ['a', 'b'] })
  })

  test('divider target IDs are validated against the live layout', () => {
    const source = layout()
    expect(applyDrawerSidebarDrop(source, 'tab:regex', drawerSidebarDividerDropId('not-found', 'before'), 'inside'))
      .toBe(source)
    expect(applyDrawerSidebarDrop(source, 'tab:regex', 'drawer-layout:divider-drop:before:', 'inside'))
      .toBe(source)
  })

  test('root start can promote a child without creating another folder', () => {
    const result = applyDrawerSidebarDrop(layout(), 'tab:macro', 'drawer-layout:root-start', 'inside')
    expect(result[0]).toEqual(tab('macro'))
    expect(result[2]).toMatchObject({ type: 'folder', children: ['regex'] })
  })

  test('bad/stale targets, self drops and attempts to nest folders do nothing', () => {
    const source = layout()
    expect(applyDrawerSidebarDrop(source, 'tab:unknown', 'folder:tools', 'inside')).toBe(source)
    expect(applyDrawerSidebarDrop(source, 'tab:profile', null, 'inside')).toBe(source)
    expect(applyDrawerSidebarDrop(source, 'tab:profile', 'tab:profile', 'inside')).toBe(source)
    expect(applyDrawerSidebarDrop(source, 'tab:profile', 'tab:nonexistent', 'inside')).toBe(source)
    expect(canMergeDrawerSidebarTabs(source, 'folder:tools', 'tab:profile')).toBe(false)
    expect(canMergeDrawerSidebarTabs(source, 'tab:profile', 'tab:regex')).toBe(false)
    expect(canMergeDrawerSidebarTabs(source, 'tab:regex', 'tab:lorebook')).toBe(true)
    expect(applyDrawerSidebarDrop(source, 'folder:tools', 'tab:profile', 'inside', true))
      .toEqual([source[1], source[0], ...source.slice(2)])
  })
})
