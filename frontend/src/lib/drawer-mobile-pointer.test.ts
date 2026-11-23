import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  DrawerMobilePointerDrag,
  drawerMobilePointerDropSide,
  type DrawerMobileDragCallbacks,
  type DrawerMobilePointer,
} from './drawer-mobile-pointer'

/** Minimal mobile DOM: real nested hit targets, pointer capture, no browser network. */
function fixture(vertical = false) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="rail">
    <div data-drawer-edge-drop="drawer-layout:root-start"></div>
    <div data-drawer-drag-id="tab:profile"><button id="profile"><span>Profile</span></button></div>
    <div data-drawer-drag-id="tab:connections"><button id="connections"><span>Connections</span></button></div>
    <div class="folderSlot" data-drawer-folder-slot=""><div data-drawer-drag-id="folder:tools"><button id="tools">Tools</button></div></div>
    <div data-drawer-edge-drop="drawer-layout:root-end"></div>
  </div></body></html>`, { pretendToBeVisual: true })
  const doc = dom.window.document
  const rail = doc.getElementById('rail')!
  rail.style.display = 'flex'
  rail.style.flexDirection = vertical ? 'column' : 'row'
  const source = rail.querySelector<HTMLElement>('[data-drawer-drag-id="tab:profile"]')!
  const other = rail.querySelector<HTMLElement>('[data-drawer-drag-id="tab:connections"]')!
  const folder = rail.querySelector<HTMLElement>('[data-drawer-drag-id="folder:tools"]')!
  const folderFrame = rail.querySelector<HTMLElement>('[data-drawer-folder-slot]')!
  const rect = (left: number, top: number, width = 50, height = 50) => ({
    left, right: left + width, top, bottom: top + height, width, height, x: left, y: top,
    toJSON() {},
  })
  rail.getBoundingClientRect = () => rect(0, 0, vertical ? 80 : 240, vertical ? 240 : 80)
  source.getBoundingClientRect = () => rect(0, 0)
  other.getBoundingClientRect = () => rect(vertical ? 0 : 60, vertical ? 60 : 0)
  folder.getBoundingClientRect = () => rect(vertical ? 0 : 120, vertical ? 120 : 0, 55)
  // The outline extends slightly beyond the header and remains a folder target.
  folderFrame.getBoundingClientRect = () => rect(vertical ? 0 : 120, vertical ? 120 : 0, vertical ? 70 : 65, vertical ? 65 : 70)
  const startEdge = rail.querySelector<HTMLElement>('[data-drawer-edge-drop="drawer-layout:root-start"]')!
  const endEdge = rail.querySelector<HTMLElement>('[data-drawer-edge-drop="drawer-layout:root-end"]')!
  Object.defineProperty(doc, 'elementFromPoint', { configurable: true, value: (x: number, y: number) => {
    const coordinate = vertical ? y : x
    if (coordinate <= 5) return startEdge
    if (coordinate < 55) return source.style.pointerEvents === 'none' ? rail : source
    if (coordinate < 115) return other.querySelector('span') ?? other
    if (coordinate < 175) return folder
    if (coordinate < 185) return folderFrame
    if (coordinate < 195) return rail // Browser returns the rail in the margin outside the outline.
    return endEdge
  } })
  let captured: number | null = null
  source.setPointerCapture = (id: number) => { captured = id }
  source.hasPointerCapture = (id: number) => captured === id
  source.releasePointerCapture = () => { captured = null }
  // Keep the scroll loop from scheduling wall-clock callbacks in the fixture.
  dom.window.requestAnimationFrame = () => 1
  dom.window.cancelAnimationFrame = () => {}
  const calls: Array<[string, ...any[]]> = []
  const callbacks: DrawerMobileDragCallbacks = {
    onStart: id => { calls.push(['start', id]) },
    onHover: (...args) => { calls.push(['hover', ...args]) },
    onDrop: (...args) => { calls.push(['drop', ...args]) },
    onCancel: () => { calls.push(['cancel']) },
  }
  const pointer = (x: number, y = 25): DrawerMobilePointer => ({
    currentTarget: source, pointerId: 4, pointerType: 'touch', isPrimary: true, button: 0,
    clientX: x, clientY: y, preventDefault() {},
  })
  return { dom, rail, source, calls, callbacks, pointer }
}

test('touch movement lifts the actual icon and commits the target beneath it', () => {
  const f = fixture()
  const drag = new DrawerMobilePointerDrag()
  try {
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    drag.move(f.pointer(85))
    expect(f.source.style.translate).toContain('60px')
    expect(f.calls).toContainEqual(['start', 'tab:profile'])
    drag.end(f.pointer(85))
    expect(f.calls.filter(call => call[0] === 'drop')).toEqual([['drop', 'tab:profile', 'tab:connections', 'inside']])
    expect(f.source.style.translate).toBe('')
  } finally { f.dom.window.close() }
})

test('pointer capture preserves the folder button as the browser click target', () => {
  const f = fixture()
  const drag = new DrawerMobilePointerDrag()
  const button = f.source.querySelector('button')!
  const captures: number[] = []
  const releases: number[] = []
  button.setPointerCapture = id => { captures.push(id) }
  button.hasPointerCapture = id => captures.includes(id)
  button.releasePointerCapture = id => { releases.push(id) }
  f.source.setPointerCapture = () => { throw new Error('Wrapper capture swallows button clicks') }
  try {
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    expect(captures).toEqual([4])
    drag.end(f.pointer(25))
    expect(releases).toEqual([4])
    expect(f.calls).toEqual([])
  } finally { f.dom.window.close() }
})

test('quick taps and stationary long presses do not change the layout', async () => {
  const f = fixture()
  const drag = new DrawerMobilePointerDrag()
  try {
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    drag.end(f.pointer(25))
    expect(f.calls).toHaveLength(0)
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    await new Promise(resolve => setTimeout(resolve, 200))
    drag.end(f.pointer(25))
    expect(f.calls.filter(call => call[0] === 'drop')).toEqual([['drop', 'tab:profile', null, 'inside']])
  } finally { f.dom.window.close() }
})

test('existing folders, edge zones, and cancellation share the same drop pipeline', () => {
  const f = fixture()
  const drag = new DrawerMobilePointerDrag()
  try {
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    drag.move(f.pointer(147))
    drag.end(f.pointer(147))
    expect(f.calls.filter(call => call[0] === 'drop')).toEqual([['drop', 'tab:profile', 'folder:tools', 'inside']])
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    drag.move(f.pointer(210))
    drag.end(f.pointer(210))
    expect(f.calls.filter(call => call[0] === 'drop').at(-1)).toEqual(['drop', 'tab:profile', 'drawer-layout:root-end', 'inside'])
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    drag.move(f.pointer(80))
    drag.cancel()
    expect(f.calls.filter(call => call[0] === 'cancel')).toHaveLength(1)
    expect(f.calls.filter(call => call[0] === 'drop')).toHaveLength(2)
  } finally { f.dom.window.close() }
})

test('a folder at the very end owns its frame, but not the trailing root boundary', () => {
  for (const vertical of [false, true]) {
    const f = fixture(vertical)
    const drag = new DrawerMobilePointerDrag()
    const point = (at: number) => vertical ? f.pointer(25, at) : f.pointer(at)
    try {
      drag.start(point(25), 'tab:profile', f.rail, f.callbacks)
      drag.move(point(180)) // Blank area INSIDE the folder frame, beyond the header.
      drag.end(point(180))
      expect(f.calls.filter(call => call[0] === 'drop').at(-1))
        .toEqual(['drop', 'tab:profile', 'folder:tools', 'inside'])

      drag.start(point(25), 'tab:profile', f.rail, f.callbacks)
      drag.move(point(190)) // Outside the folder; elementFromPoint returns bare rail.
      drag.end(point(190))
      expect(f.calls.filter(call => call[0] === 'drop').at(-1))
        .toEqual(['drop', 'tab:profile', 'drawer-layout:root-end', 'inside'])
    } finally { f.dom.window.close() }
  }
})

test('vertical coarse-pointer layouts use y geometry rather than x', () => {
  const f = fixture(true)
  const drag = new DrawerMobilePointerDrag()
  try {
    drag.start(f.pointer(25), 'tab:profile', f.rail, f.callbacks)
    drag.move(f.pointer(25, 90))
    drag.end(f.pointer(25, 90))
    expect(f.calls.filter(call => call[0] === 'drop')).toEqual([['drop', 'tab:profile', 'tab:connections', 'inside']])
    expect(drawerMobilePointerDropSide(20, { left: 0, width: 50, top: 60, height: 50 }, 63, false)).toBe('before')
    expect(drawerMobilePointerDropSide(20, { left: 0, width: 50, top: 60, height: 50 }, 107, false)).toBe('after')
  } finally { f.dom.window.close() }
})


test('divider hit halves beat the trailing folder, in both vertical and horizontal rails', () => {
  for (const vertical of [false, true]) {
    const f = fixture(vertical)
    const drag = new DrawerMobilePointerDrag()
    const doc = f.rail.ownerDocument
    const divider = doc.createElement('div')
    divider.setAttribute('data-drawer-divider', '')
    const before = doc.createElement('div')
    before.dataset.drawerDividerDrop = 'drawer-layout:divider-drop:before:sections'
    const after = doc.createElement('div')
    after.dataset.drawerDividerDrop = 'drawer-layout:divider-drop:after:sections'
    divider.append(before, after)
    f.rail.insertBefore(divider, f.rail.querySelector('[data-drawer-edge-drop="drawer-layout:root-end"]'))
    const rect = (left: number, top: number) => ({
      left, right: left + 22, top, bottom: top + 22, width: 22, height: 22,
      x: left, y: top, toJSON() {},
    })
    divider.getBoundingClientRect = () => rect(vertical ? 0 : 195, vertical ? 195 : 0)
    // Mimic browser elementFromPoint returning either droppable half.
    Object.defineProperty(doc, 'elementFromPoint', {
      configurable: true,
      value: (x: number, y: number) => (vertical ? y : x) < 206 ? before : after,
    })
    const point = (at: number) => vertical ? f.pointer(25, at) : f.pointer(at)
    try {
      for (const [at, side] of [[200, 'before'], [212, 'after']] as const) {
        drag.start(point(25), 'tab:profile', f.rail, f.callbacks)
        drag.move(point(at))
        drag.end(point(at))
        expect(f.calls.filter(call => call[0] === 'drop').at(-1))
          .toEqual(['drop', 'tab:profile', `drawer-layout:divider-drop:${side}:sections`, 'inside'])
      }
    } finally { f.dom.window.close() }
  }
})


test('mobile divider boundaries remain reachable along the tab centerline, even outside their thin cross-axis box', () => {
  for (const vertical of [false, true]) {
    const f = fixture(vertical)
    const doc = f.rail.ownerDocument
    const divider = doc.createElement('div')
    divider.setAttribute('data-drawer-divider', '')
    const before = doc.createElement('div')
    before.dataset.drawerDividerDrop = 'drawer-layout:divider-drop:before:sections'
    const after = doc.createElement('div')
    after.dataset.drawerDividerDrop = 'drawer-layout:divider-drop:after:sections'
    divider.append(before, after)
    f.rail.insertBefore(divider, f.rail.querySelector('[data-drawer-edge-drop="drawer-layout:root-end"]'))
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, right: left + width, top, bottom: top + height, width, height,
      x: left, y: top, toJSON() {},
    })
    divider.getBoundingClientRect = () => vertical ? rect(0, 195, 22, 24) : rect(195, 0, 24, 22)
    // This is the actual missed mobile case: the finger is level with a
    // 48px labeled button, past the divider's 22px cross-axis hitbox.
    // elementFromPoint therefore returns the rail, not either divider half.
    Object.defineProperty(doc, 'elementFromPoint', { configurable: true, value: () => f.rail })
    const point = (at: number) => vertical ? f.pointer(44, at) : f.pointer(at, 44)
    const drag = new DrawerMobilePointerDrag()
    try {
      for (const [at, side] of [[201, 'before'], [212, 'after'], [188, 'before'], [226, 'after']] as const) {
        // 188 and 226 are *outside* the 24px divider, but within 10px of its edges.
        drag.start(point(25), 'tab:profile', f.rail, f.callbacks)
        drag.move(point(at))
        expect(f.calls.filter(call => call[0] === 'hover').at(-1))
          .toEqual(['hover', 'tab:profile', `drawer-layout:divider-drop:${side}:sections`, 'inside'])
        drag.end(point(at))
        expect(f.calls.filter(call => call[0] === 'drop').at(-1))
          .toEqual(['drop', 'tab:profile', `drawer-layout:divider-drop:${side}:sections`, 'inside'])
      }
      // The catchment must NOT swallow normal icon drops farther from the divider.
      const far = vertical ? f.pointer(44, 178) : f.pointer(178, 44)
      drag.start(point(25), 'tab:profile', f.rail, f.callbacks)
      drag.move(far)
      drag.end(far)
      expect(f.calls.filter(call => call[0] === 'drop').at(-1)?.[2]).not.toContain('divider-drop')
      // An offscreen divider cannot steal any target, even if its stale rectangle is nearby.
      divider.getBoundingClientRect = () => vertical ? rect(0, 250, 22, 24) : rect(250, 0, 24, 22)
      const last = vertical ? f.pointer(44, 228) : f.pointer(228, 44)
      drag.start(point(25), 'tab:profile', f.rail, f.callbacks)
      drag.move(last)
      drag.end(last)
      expect(f.calls.filter(call => call[0] === 'drop').at(-1)?.[2]).not.toContain('divider-drop')
    } finally { f.dom.window.close() }
  }
})
