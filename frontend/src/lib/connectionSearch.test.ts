import { expect, test } from 'bun:test'
import { filterConnections } from './connectionSearch'

const profiles = [
  { id: 'a', name: 'Writing', provider: 'openai', model: 'gpt-example' },
  { id: 'b', name: 'Images', provider: 'local', model: 'flux-example' },
  { id: 'c', provider: 'local', model: 'embed-example' },
]

test('connection search matches fields, whitespace and case without changing input order', () => {
  expect(filterConnections(profiles, '  LOCAL   example ').map(p => p.id)).toEqual(['b', 'c'])
  expect(filterConnections(profiles, 'WRITING').map(p => p.id)).toEqual(['a'])
  expect(filterConnections(profiles, 'gpt').map(p => p.id)).toEqual(['a'])
  expect(filterConnections(profiles, 'missing')).toEqual([])
  expect(filterConnections(profiles, '  ')).toEqual(profiles)
})

test('folder name searches include all matching folder members', () => {
  expect(filterConnections(profiles, 'favorites', id => id === 'c' ? '' : 'Favorites').map(p => p.id))
    .toEqual(['a', 'b'])
})
