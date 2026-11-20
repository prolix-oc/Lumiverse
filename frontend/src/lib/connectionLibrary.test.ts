import { expect, test } from 'bun:test'
import {
  assignConnectionFolder, connectionFolderId, connectionFolderName, deleteConnectionFolder,
  normalizeConnectionLibrary, orderedConnectionFolders, renameConnectionFolder,
} from './connectionLibrary'

const library = normalizeConnectionLibrary({
  folders: [{ id: 'local', name: 'Local' }, { id: 'remote', name: 'Remote' }],
  folderOrder: ['remote', '', 'local'], assignments: { a: 'local', b: 'remote' },
})

test('stored folder order includes Uncategorized and survives normalization', () => {
  expect(orderedConnectionFolders(library).map(folder => folder.name)).toEqual(['Remote', '', 'Local'])
  expect(normalizeConnectionLibrary(JSON.parse(JSON.stringify(library)))).toEqual(library)
})

test('rename preserves membership and position; delete returns members to Uncategorized', () => {
  const renamed = renameConnectionFolder(library, 'local', 'Home')
  expect(connectionFolderName(renamed, 'a')).toBe('Home')
  expect(renamed.folderOrder).toEqual(library.folderOrder)
  expect(renamed.assignments).toEqual(library.assignments)
  const deleted = deleteConnectionFolder(renamed, 'local')
  expect(connectionFolderId(deleted, 'a')).toBe('')
  expect(connectionFolderName(deleted, 'b')).toBe('Remote')
  expect(deleted.folderOrder).toEqual(['remote', ''])
  expect(connectionFolderName(library, 'a')).toBe('Local')
})

test('moving a connection affects only its membership', () => {
  const moved = assignConnectionFolder(library, 'a', 'remote')
  expect(moved.assignments).toEqual({ a: 'remote', b: 'remote' })
  expect(moved.folderOrder).toEqual(library.folderOrder)
  expect(connectionFolderId(assignConnectionFolder(moved, 'a', ''), 'a')).toBe('')
  expect(connectionFolderId(assignConnectionFolder(moved, 'a', 'missing'), 'a')).toBe('')
})

test('malformed or stale settings cannot strand connections or duplicate groups', () => {
  const normalized = normalizeConnectionLibrary({
    folders: [null, {}, { id: 'a', name: 'Home' }, { id: 'a', name: 'Duplicate ID' }, { id: 'b', name: 'home' }],
    folderOrder: ['missing', 'a', 'a', null], assignments: { valid: 'a', gone: 'missing', malformed: {} },
  })
  expect(normalized.folders).toEqual([{ id: 'a', name: 'Home' }])
  expect(normalized.folderOrder).toEqual(['a', ''])
  expect(normalized.assignments).toEqual({ valid: 'a' })
  for (const value of [null, [], 'bad', 42]) expect(normalizeConnectionLibrary(value).folderOrder).toEqual([''])
})

test('personal embedding order survives folder deletion without rewriting profile configuration', () => {
  const ordered = normalizeConnectionLibrary({ ...library, profileOrder: ['b', 'a', 'b', null] })
  expect(ordered.profileOrder).toEqual(['b', 'a'])
  expect(deleteConnectionFolder(ordered, 'local').profileOrder).toEqual(['b', 'a'])
})
