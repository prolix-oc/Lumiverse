import { describe, expect, test } from 'bun:test'
import {
  constrainImageLightboxZoom,
  pinchImageLightboxZoom,
  INITIAL_IMAGE_LIGHTBOX_ZOOM,
} from './imageLightboxZoom'

const bounds = {
  imageWidth: 360,
  imageHeight: 600,
  viewportWidth: 400,
  viewportHeight: 800,
}

describe('image lightbox zoom', () => {
  test('keeps the pinch midpoint anchored on the image', () => {
    expect(pinchImageLightboxZoom(
      INITIAL_IMAGE_LIGHTBOX_ZOOM,
      100,
      200,
      { x: 50, y: 40 },
      { x: 70, y: 60 },
      bounds,
    )).toEqual({ scale: 2, x: -30, y: -20 })
  })

  test('clamps scale and pan so the image can be pulled to its edges', () => {
    expect(constrainImageLightboxZoom({ scale: 2, x: 500, y: -500 }, bounds))
      .toEqual({ scale: 2, x: 160, y: -200 })
    expect(constrainImageLightboxZoom({ scale: 9, x: 0, y: 0 }, bounds).scale).toBe(4)
  })

  test('returns to the centered image when pinched back to its original size', () => {
    expect(pinchImageLightboxZoom(
      { scale: 2, x: -50, y: 40 },
      200,
      100,
      { x: 50, y: 0 },
      { x: 70, y: 20 },
      bounds,
    )).toEqual(INITIAL_IMAGE_LIGHTBOX_ZOOM)
  })
})
