import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FLOATING_AVATAR_DRAG_BAR_HEIGHT,
  FLOATING_AVATAR_VIEWPORT_PAD,
  centerFloatingAvatar,
  clampFloatingAvatarPosition,
  getFloatingAvatarViewportMax,
  type FloatingAvatarViewport,
} from './floatingAvatarGeometry'

const css = readFileSync(join(import.meta.dir, 'FloatingAvatarViewer.module.css'), 'utf8')

const phoneViewports: Array<[string, FloatingAvatarViewport]> = [
  ['standard iPhone portrait', { width: 390, height: 664 }],
  ['Pro Max iPhone portrait', { width: 430, height: 740 }],
]

describe('floating avatar phone sizing', () => {
  test('does not hide the viewer at narrow viewport widths', () => {
    expect(css).not.toMatch(/@media\s*\(max-width:\s*400px\)[\s\S]*?\.container\s*\{[\s\S]*?display:\s*none/)
  })

  for (const [name, viewport] of phoneViewports) {
    test(`keeps the default avatar reachable on ${name}`, () => {
      const size = { width: 280, height: 280 }
      const position = centerFloatingAvatar(size, viewport)

      expect(position.x).toBeGreaterThanOrEqual(FLOATING_AVATAR_VIEWPORT_PAD)
      expect(position.y).toBeGreaterThanOrEqual(FLOATING_AVATAR_VIEWPORT_PAD)
      expect(position.x + size.width).toBeLessThanOrEqual(
        viewport.width - FLOATING_AVATAR_VIEWPORT_PAD,
      )
      expect(position.y + size.height + FLOATING_AVATAR_DRAG_BAR_HEIGHT).toBeLessThanOrEqual(
        viewport.height - FLOATING_AVATAR_VIEWPORT_PAD,
      )
    })

    test(`clamps a maximized avatar inside ${name}`, () => {
      const { maxW, maxH } = getFloatingAvatarViewportMax(viewport)
      const position = clampFloatingAvatarPosition(
        { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER },
        { width: maxW, height: maxH },
        viewport,
      )

      expect(position).toEqual({
        x: FLOATING_AVATAR_VIEWPORT_PAD,
        y: FLOATING_AVATAR_VIEWPORT_PAD,
      })
      expect(position.x + maxW).toBe(viewport.width - FLOATING_AVATAR_VIEWPORT_PAD)
      expect(position.y + maxH + FLOATING_AVATAR_DRAG_BAR_HEIGHT).toBe(
        viewport.height - FLOATING_AVATAR_VIEWPORT_PAD,
      )
    })
  }
})
