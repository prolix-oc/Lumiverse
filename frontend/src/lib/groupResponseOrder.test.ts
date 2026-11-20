import { describe, expect, test } from 'bun:test'
import { orderGroupResponseIds, readGroupResponseOrder } from './groupResponseOrder'

describe('group response order', () => {
  test('defaults unknown metadata to sequential', () => {
    expect(readGroupResponseOrder(null)).toBe('sequential')
    expect(readGroupResponseOrder({ group_response_order: 'bogus' })).toBe('sequential')
    expect(readGroupResponseOrder({ group_response_order: 'random' })).toBe('random')
  })

  test('keeps sequential order and removes duplicate ids', () => {
    expect(orderGroupResponseIds(['a', 'b', 'a', 'c'], 'sequential')).toEqual(['a', 'b', 'c'])
  })

  test('randomizes ids with injectable random source', () => {
    const rolls = [0.1, 0.9]
    expect(orderGroupResponseIds(['a', 'b', 'c'], 'random', {
      random: () => rolls.shift() ?? 0,
    })).toEqual(['c', 'b', 'a'])
  })

  test('keeps directly mentioned ids first before randomizing the rest', () => {
    const rolls = [0.1]
    expect(orderGroupResponseIds(['a', 'b', 'c'], 'random', {
      priorityIds: ['b'],
      random: () => rolls.shift() ?? 0,
    })).toEqual(['b', 'c', 'a'])
  })
})
