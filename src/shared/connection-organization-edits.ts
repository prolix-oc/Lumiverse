import { normalizeConnectionLibrary, assignConnectionFolder, deleteConnectionFolder,
  renameConnectionFolder, type ConnectionLibraryKind } from './connection-library';
import { withRecentConnection } from './connection-recents';

export const ORGANIZATION_KEYS = ['connectionLibraries', 'connectionsOrder', 'recentConnections'] as const;
export type OrganizationSettingKey = typeof ORGANIZATION_KEYS[number];
export type OrganizationEdit = { kind: ConnectionLibraryKind } & (
  | { action: 'create'; id: string; name: string }
  | { action: 'rename'; id: string; name: string; previous: string }
  | { action: 'delete'; id: string }
  | { action: 'move'; id: string; folderId: string; previous: string }
  | { action: 'folders' | 'connections'; ids: string[]; previous: string[] }
  | { action: 'remember'; id: string }
);
type Settings = Partial<Record<OrganizationSettingKey | 'connectionsPickerSettings', any>>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
const conflict = () => { throw Object.assign(new Error('Connection organization changed. Reload and retry.'), { code: 'CONNECTION_ORGANIZATION_CONFLICT' }); };

/** Convert a native edit into intent, so unrelated kinds, folders and moves are never replaced. */
export function organizationEdits(key: OrganizationSettingKey, before: any, after: any): OrganizationEdit[] {
  const edits: OrganizationEdit[] = [];
  for (const kind of ['llm', 'imageGen', 'tts', 'stt', 'embedding', 'decision'] as const) {
    if (equal(before?.[kind], after?.[kind])) continue;
    if (key === 'recentConnections') {
      const id = ids(after?.[kind])[0];
      if (id) edits.push({ kind, action: 'remember', id });
    } else if (key === 'connectionsOrder') {
      edits.push({ kind, action: 'connections', ids: ids(after?.[kind]), previous: ids(before?.[kind]) });
    } else {
      const previous = normalizeConnectionLibrary(before?.[kind]);
      const next = normalizeConnectionLibrary(after?.[kind]);
      for (const folder of next.folders) {
        const old = previous.folders.find(value => value.id === folder.id);
        if (!old) edits.push({ kind, action: 'create', ...folder });
        else if (folder.name !== old.name) edits.push({ kind, action: 'rename', ...folder, previous: old.name });
      }
      // Moves precede deletions so a folder deletion's implicit moves remain atomic.
      for (const id of new Set([...Object.keys(previous.assignments), ...Object.keys(next.assignments)])) {
        if (previous.assignments[id] !== next.assignments[id]) edits.push({ kind, action: 'move', id,
          folderId: next.assignments[id] ?? '', previous: previous.assignments[id] ?? '' });
      }
      for (const folder of previous.folders) if (!next.folders.some(value => value.id === folder.id)) edits.push({ kind, action: 'delete', id: folder.id });
      // Creating/deleting changes folder order itself; compare the order after those edits.
      let interim = previous.folderOrder.filter(id => id === '' || next.folders.some(folder => folder.id === id));
      for (const folder of next.folders) if (!previous.folders.some(old => old.id === folder.id)) interim = interim.flatMap(id => id === '' ? [folder.id, ''] : [id]);
      if (!equal(interim, next.folderOrder)) edits.push({ kind, action: 'folders', ids: next.folderOrder, previous: interim });
      if (!equal(previous.profileOrder, next.profileOrder)) edits.push({ kind, action: 'connections', ids: next.profileOrder ?? [], previous: previous.profileOrder ?? [] });
    }
  }
  return edits;
}

export function applyOrganizationEdits(settings: Settings, edits: OrganizationEdit[]): Settings {
  const result = structuredClone(settings);
  for (const edit of edits) {
    const library = normalizeConnectionLibrary(result.connectionLibraries?.[edit.kind]);
    let next = library;
    switch (edit.action) {
      case 'create': {
        const existing = library.folders.find(folder => folder.id === edit.id);
        if (existing?.name === edit.name) break; // Safe retry after a lost response.
        if (existing || library.folders.some(folder => folder.name.toLowerCase() === edit.name.toLowerCase())) conflict();
        next = { ...library, folders: [...library.folders, { id: edit.id, name: edit.name }],
          folderOrder: library.folderOrder.flatMap(id => id === '' ? [edit.id, ''] : [id]) }; break;
      }
      case 'rename': {
        const current = library.folders.find(folder => folder.id === edit.id)?.name;
        if (current !== edit.name && current !== edit.previous) conflict();
        if (library.folders.some(folder => folder.id !== edit.id && folder.name.toLowerCase() === edit.name.toLowerCase())) conflict();
        next = renameConnectionFolder(library, edit.id, edit.name); break;
      }
      case 'delete': next = deleteConnectionFolder(library, edit.id); break;
      case 'move': {
        const current = library.assignments[edit.id] ?? '';
        if (current !== edit.folderId && current !== edit.previous) conflict();
        if (edit.folderId && !library.folders.some(folder => folder.id === edit.folderId)) conflict();
        next = assignConnectionFolder(library, edit.id, edit.folderId); break;
      }
      case 'folders':
        if (!equal(library.folderOrder, edit.ids) && !equal(library.folderOrder, edit.previous)) conflict();
        next = normalizeConnectionLibrary({ ...library, folderOrder: edit.ids }); break;
      case 'connections': {
        const current = edit.kind === 'embedding' ? library.profileOrder ?? [] : ids(result.connectionsOrder?.[edit.kind]);
        if (!equal(current, edit.ids) && !equal(current, edit.previous)) conflict();
        if (edit.kind === 'embedding') next = { ...library, profileOrder: edit.ids };
        else result.connectionsOrder = { ...result.connectionsOrder, [edit.kind]: edit.ids };
        break;
      }
      case 'remember': result.recentConnections = withRecentConnection(result.recentConnections, edit.kind, edit.id,
        result.connectionsPickerSettings?.recentProfileIds); break;
    }
    if (next !== library) result.connectionLibraries = { ...result.connectionLibraries, [edit.kind]: next };
  }
  return result;
}

export function validateOrganizationEdits(value: unknown): asserts value is OrganizationEdit[] {
  const string = (v: unknown, empty = false) => typeof v === 'string' && (empty || v.length > 0) && v.length <= 256;
  const list = (v: unknown) => Array.isArray(v) && v.length <= 10000 && v.every(id => string(id, true)) && new Set(v).size === v.length;
  const valid = Array.isArray(value) && value.length <= 1000 && value.every(edit => {
    if (!edit || !['llm', 'imageGen', 'tts', 'stt', 'embedding', 'decision'].includes(edit.kind)) return false;
    switch (edit.action) {
      case 'create': case 'rename': return string(edit.id) && string(edit.name) && edit.name === edit.name.trim() && edit.name.length <= 64
        && edit.name.toLowerCase() !== 'uncategorized' && (edit.action === 'create' || string(edit.previous));
      case 'delete': case 'remember': return string(edit.id);
      case 'move': return string(edit.id) && string(edit.folderId, true) && string(edit.previous, true);
      case 'folders': case 'connections': return list(edit.ids) && list(edit.previous);
      default: return false;
    }
  });
  if (!valid) throw Object.assign(new Error('Invalid connection organization edit'), { code: 'CONNECTION_ORGANIZATION_INVALID' });
}
