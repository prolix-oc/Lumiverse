import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { editConnectionOrganizationWithDb } from './connection-organization-operations';
import { organizationEdits, applyOrganizationEdits } from '../shared/connection-organization-edits';

function fixture() {
  const db = new Database(':memory:');
  db.run('CREATE TABLE settings (key TEXT, user_id TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(key,user_id))');
  return db;
}
test('independent concurrent folder and kind edits merge without replacing settings', () => {
  const db = fixture();
  try {
    editConnectionOrganizationWithDb(db, 'a', [{ kind: 'llm', action: 'create', id: 'work', name: 'Work' }]);
    editConnectionOrganizationWithDb(db, 'a', [{ kind: 'imageGen', action: 'create', id: 'art', name: 'Art' }]);
    const result = editConnectionOrganizationWithDb(db, 'a', [{ kind: 'llm', action: 'create', id: 'home', name: 'Home' }]);
    expect(result.connectionLibraries.llm.folders.map((f: any) => f.id)).toEqual(['work', 'home']);
    expect(result.connectionLibraries.imageGen.folders[0].id).toBe('art');
    expect(editConnectionOrganizationWithDb(db, 'b', []).connectionLibraries).toEqual({});
  } finally { db.close(); }
});
test('stale reorders reject and roll back the entire edit batch', () => {
  const db = fixture();
  try {
    editConnectionOrganizationWithDb(db, 'a', [{ kind: 'llm', action: 'connections', ids: ['b', 'a'], previous: [] }]);
    expect(() => editConnectionOrganizationWithDb(db, 'a', [
      { kind: 'llm', action: 'create', id: 'work', name: 'Work' },
      { kind: 'llm', action: 'connections', ids: ['a', 'b'], previous: [] },
    ])).toThrow('changed');
    const result = editConnectionOrganizationWithDb(db, 'a', []);
    expect(result.connectionLibraries).toEqual({});
    expect(result.connectionsOrder.llm).toEqual(['b', 'a']);
  } finally { db.close(); }
});
test('native diffs round-trip folder creation, rename, moves, deletion and order', () => {
  let settings: any = {};
  const variants = [
    { folders: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], folderOrder: ['b', '', 'a'], assignments: { p: 'a' } },
    { folders: [{ id: 'a', name: 'Renamed' }, { id: 'b', name: 'B' }], folderOrder: ['a', 'b', ''], assignments: { p: 'b' } },
    { folders: [{ id: 'a', name: 'Renamed' }], folderOrder: ['a', ''], assignments: {} },
  ];
  for (const library of variants) {
    const next = { llm: library };
    settings = applyOrganizationEdits(settings, organizationEdits('connectionLibraries', settings.connectionLibraries, next));
    expect(settings.connectionLibraries).toEqual(next);
  }
});
test('recent history merges usage and does not apply the UI four-row cap', () => {
  const db = fixture();
  try {
    for (let i = 0; i < 9; i++) editConnectionOrganizationWithDb(db, 'a', [{ kind: 'llm', action: 'remember', id: `${i}` }]);
    const result = editConnectionOrganizationWithDb(db, 'a', [{ kind: 'llm', action: 'remember', id: '4' }]);
    expect(result.recentConnections.llm).toEqual(['4', '8', '7', '6', '5', '3', '2', '1']);
  } finally { db.close(); }
});
