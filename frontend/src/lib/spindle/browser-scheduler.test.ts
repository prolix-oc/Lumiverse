import { afterEach, describe, expect, test } from 'bun:test'
import { yieldToBrowser } from './browser-scheduler'

const originalRequestAnimationFrame = window.requestAnimationFrame
const originalCancelAnimationFrame = window.cancelAnimationFrame

afterEach(() => {
  window.requestAnimationFrame = originalRequestAnimationFrame
  window.cancelAnimationFrame = originalCancelAnimationFrame
})

describe('yieldToBrowser', () => {
  test('falls back to a timer when animation frames are suspended', async () => {
    const cancelledFrames: number[] = []
    let stalledFrame: FrameRequestCallback | undefined

    window.requestAnimationFrame = (callback) => {
      stalledFrame = callback
      return 41
    }
    window.cancelAnimationFrame = (frameId) => {
      cancelledFrames.push(frameId)
    }

    await yieldToBrowser({ when: 'paint', timeoutMs: 1 })

    expect(cancelledFrames).toEqual([41])
    expect(stalledFrame).toBeDefined()
    expect(() => stalledFrame!(performance.now())).not.toThrow()
    expect(cancelledFrames).toEqual([41])
  })
})
