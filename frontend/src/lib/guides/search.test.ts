import { expect, test } from 'bun:test'
import { indexGuides, rankGuides } from './search'

test('ranks title, path, and body matches and requires each query term', () => {
  const guides = indexGuides([
    { path: 'other.md', title: 'Other', searchText: 'Configure a chat profile here.' },
    { path: 'settings/chat-profiles.md', title: 'Connection settings' },
    { path: 'chat.md', title: 'Chat' },
    { path: 'profiles.md', title: 'Chát Profile' },
  ])
  const ranked = rankGuides(guides, ' Chát profile ')
  expect(ranked.map((guide) => guide.path)).toEqual([
    'profiles.md', 'settings/chat-profiles.md', 'other.md',
  ])
  expect(ranked[2].snippet).toContain('Configure a chat profile here')
  expect(rankGuides(guides, 'chat config').map((guide) => guide.path)).toEqual(['other.md'])
  expect(rankGuides(guides, '   ')).toEqual([])
})
