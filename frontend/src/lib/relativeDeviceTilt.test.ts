import { describe, expect, test } from 'bun:test'
import { createRelativeDeviceTilt, orientationQuaternion } from './relativeDeviceTilt'
import type { DeviceAttitudeQuaternion, DeviceRotationSnapshot } from './deviceRotation'

function reading(beta: number, gamma = 0, alpha = 0): DeviceRotationSnapshot {
  return { orientation: { alpha, beta, gamma, absolute: false }, rotationRate: null,
    timestamp: 10, permission: 'granted', hasReading: true }
}
function native(quaternion: DeviceAttitudeQuaternion): DeviceRotationSnapshot {
  return { ...reading(0), orientation: null, quaternion }
}
const identity = { x: 0, y: 0, z: 0, w: 1 }

describe('relative avatar tilt', () => {
  test('calibrates to the current grip with gentler horizontal sensitivity', () => {
    const tilt = createRelativeDeviceTilt()
    expect(tilt(reading(70), 0)).toEqual({ x: 0, y: 0 })
    const vertical = tilt(reading(75), 0)!
    expect(vertical.x).toBeCloseTo(0)
    expect(vertical.y).toBeCloseTo(0.30271)
    const horizontal = tilt(reading(70, 5), 0)!
    expect(horizontal.x).toBeCloseTo(0.20537)
    expect(horizontal.y).toBeCloseTo(0)
  })

  test('remains continuous across upright and beta wrap boundaries', () => {
    const upright = createRelativeDeviceTilt()
    upright(reading(89), 0)
    expect(upright(reading(91), 0)!.y).toBeCloseTo(0.12435)
    const wrap = createRelativeDeviceTilt()
    wrap(reading(179), 0)
    expect(wrap(reading(-179), 0)!.y).toBeCloseTo(0.12435)
  })

  test('handles heading wrap while upright without losing horizontal tilt', () => {
    const tilt = createRelativeDeviceTilt()
    tilt(reading(90, 0, 359), 0)
    const result = tilt(reading(90, 0, 1), 0)!
    expect(result.x).toBeCloseTo(0.08314)
    expect(result.y).toBeCloseTo(0)
  })

  test.each([0, 90, 180, 270])('maps device axes into screen axes at %i degrees', (angle) => {
    const tilt = createRelativeDeviceTilt()
    tilt(reading(0), angle)
    const result = tilt(reading(5), angle)!
    expect(result.x).toBeCloseTo(Math.sin(angle * Math.PI / 180) * 0.20537)
    expect(result.y).toBeCloseTo(Math.cos(angle * Math.PI / 180) * 0.30271)
  })

  test('uses native quaternions and treats a negated quaternion as the same orientation', () => {
    const tilt = createRelativeDeviceTilt()
    tilt(native(identity), 0)
    const q = orientationQuaternion(reading(5).orientation!)!
    expect(tilt(native(q), 0)!.y).toBeCloseTo(0.30271)
    const negative = { x: -q.x, y: -q.y, z: -q.z, w: -q.w }
    expect(tilt(native(negative), 0)!.y).toBeCloseTo(0.30271)
  })

  test('recalibrates after rotation or sensor restart and preserves the grip across idle gaps', () => {
    const tilt = createRelativeDeviceTilt()
    tilt(reading(60), 0)
    expect(tilt(reading(65), 90)).toEqual({ x: 0, y: 0 })
    expect(tilt({ ...reading(70), reference: 1 }, 90)).toEqual({ x: 0, y: 0 })
    expect(tilt({ ...reading(75), reference: 1, timestamp: 2000 }, 90)!.x).toBeCloseTo(0.20537)
  })

  test('keeps responding well beyond ten degrees without a hard stop', () => {
    const tilt = createRelativeDeviceTilt()
    tilt(reading(70), 0)
    const positions = [10, 20, 30, 40].map(gamma => tilt(reading(70, gamma), 0)!.x)
    expect(positions[0]).toBeLessThan(0.5)
    for (let i = 1; i < positions.length; i++) expect(positions[i] - positions[i - 1]).toBeGreaterThan(0.07)
    expect(positions[3]).toBeLessThan(1)
  })

  test('responds equally towards and away from the viewer', () => {
    const tilt = createRelativeDeviceTilt()
    tilt(reading(70), 0)
    for (const delta of [5, 10, 20, 30]) {
      expect(tilt(reading(70 + delta), 0)!.y).toBeCloseTo(-tilt(reading(70 - delta), 0)!.y)
    }
  })

  test('ignores incomplete readings and smoothly bounds large movements', () => {
    const tilt = createRelativeDeviceTilt()
    expect(tilt({ ...reading(0), orientation: null }, 0)).toBeNull()
    tilt(reading(0), 0)
    expect(tilt(reading(80), 0)!.y).toBeGreaterThan(0.99)
    expect(tilt(reading(80), 0)!.y).toBeLessThan(1)
    expect(tilt(reading(-80), 0)!.y).toBeGreaterThan(-1)
    expect(tilt(reading(-80), 0)!.y).toBeLessThan(-0.99)
  })
})
