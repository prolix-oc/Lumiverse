import { describe, expect, spyOn, test } from 'bun:test'
import { measureBenchmarkFixture } from './benchmark-source'

describe('benchmark sampling', () => {
  test('retains batch sizes and reports the median per call', () => {
    const times = [0, 3, 3, 9, 9, 21]
    const clock = spyOn(performance, 'now').mockImplementation(() => times.shift()!)
    let calls = 0
    try {
      expect(measureBenchmarkFixture(() => { calls++ }, n => 'x'.repeat(n), 3, [1])).toEqual([
        { size: 1, characters: 1, iterations: 3, samples: 3, medianMs: 2, stopped: false },
      ])
      expect(calls).toBe(9)
    } finally { clock.mockRestore() }
  })

  test.each([
    [300, [1], [true], [1]],
    [200, [3, 3], [false, true], [1, 1, 1, 2, 2, 2]],
  ] as const)('retains stopping budgets with %i ms samples', (duration, samples, stopped, lengths) => {
    let now = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    const calls: number[] = []
    try {
      const result = measureBenchmarkFixture(raw => { now += duration; calls.push(raw.length) }, n => 'x'.repeat(n), 1, [1, 2, 4])
      expect(result.map(row => row.samples)).toEqual([...samples])
      expect(result.map(row => row.stopped)).toEqual([...stopped])
      expect(calls).toEqual([...lengths])
    } finally { clock.mockRestore() }
  })
})
