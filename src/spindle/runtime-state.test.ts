import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { runMigrations } from '../db/migrate';
import * as characters from '../services/characters.service';
import * as chats from '../services/chats.service';
import * as personas from '../services/personas.service';
import * as settings from '../services/settings.service';
import * as books from '../services/world-books.service';
import { readRuntimeState, writeRuntimeState } from './runtime-state';
import { runtimeStateRevision, withRuntimeMutation } from './runtime-state-revision';
import { WorkerHostStateApi } from './worker-host-state-api';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';
import { Hono } from 'hono';
import { settingsRoutes } from '../routes/settings.routes';
import * as vectorStore from '../services/vector-store';
import { LanceDbStore } from '../services/vector-store/providers/lancedb';

let characterId: string;
let chatId: string;
let vectorStoreSpy: ReturnType<typeof spyOn>;
let vectorDeleteError: Error | undefined;
beforeEach(async () => {
  vectorDeleteError = undefined;
  vectorStoreSpy = spyOn(vectorStore, 'getActiveVectorStore').mockResolvedValue(Object.assign(new LanceDbStore(), {
    capabilities: { ...vectorStore.LANCEDB_CAPABILITIES, supportsOptimize: false, requiresExplicitFlush: false },
    deleteByFilter: async (collection: string) => {
      if (collection === 'embeddings_world_books' && vectorDeleteError) throw vectorDeleteError;
    },
  }));
  closeDatabase();
  await runMigrations(initDatabase(':memory:'));
  for (const id of ['owner', 'other']) getDb().run('INSERT INTO user(id,name,email) VALUES(?,?,?)', [id, id, id + '@example.test']);
  characterId = characters.createCharacter('owner', { name: 'Character', extensions: { privatePayload: 'x'.repeat(500_000) } }).id;
  chatId = chats.createChatRaw('owner', { character_id: characterId, metadata: { preserved: 'value', chat_variables: { a: '1' } } }).id;
});
afterEach(() => { vectorStoreSpy.mockRestore(); closeDatabase(); });

test('atomic state projects runtime fields without character extensions and includes current persona and lore', () => {
  const persona = personas.createPersona('owner', { name: 'Persona', description: 'Description' });
  settings.putSetting('owner', 'activePersonaId', persona.id);
  settings.putSetting('owner', 'macro_variables_global', { global: 'value' });
  const book = books.createWorldBook('owner', { name: 'Book' });
  const entry = books.createEntry('owner', book.id, { content: 'Lore', key: ['key'] })!;
  characters.updateCharacter('owner', characterId, { extensions: { world_book_ids: [book.id] } });
  const state = readRuntimeState('owner', chatId, characterId);
  expect(state.revision).toEqual(runtimeStateRevision('owner'));
  expect(state.character).not.toHaveProperty('extensions');
  expect(state.character.world_book_ids).toEqual([book.id]);
  expect(state.persona?.id).toBe(persona.id);
  expect(state.lore.map(value => value.id)).toEqual([entry.id]);
  expect(state.globalVariables).toEqual({ global: 'value' });
  expect(() => readRuntimeState('other', chatId, characterId)).toThrow();
});

test('variable deltas preserve metadata and unmodified variables; acknowledgements advance with published events', async () => {
  const before = runtimeStateRevision('owner');
  const result = await writeRuntimeState('owner', chatId, { kind: 'chat.variables', values: { b: '2' } });
  expect(result.revision.sequence).toBeGreaterThan(before.sequence);
  expect(result.patch.chat).toEqual(chats.getChat('owner', chatId));
  expect(chats.getChat('owner', chatId)?.metadata).toEqual({ preserved: 'value', chat_variables: { a: '1', b: '2' } });
  await expect(writeRuntimeState('other', chatId, { kind: 'chat.variables', values: { a: 'stolen' } })).rejects.toThrow();
});

test('client message identifiers preserve system roles and cannot overwrite an existing or foreign message', async () => {
  const id = crypto.randomUUID();
  const created = await writeRuntimeState('owner', chatId, { kind: 'message.create', id, content: 'System', role: 'system' });
  expect(created.patch.message).toMatchObject({ id, content: 'System', role: 'system' });
  expect(readRuntimeState('owner', chatId, characterId).messages[0]?.role).toBe('system');
  await expect(writeRuntimeState('owner', chatId, { kind: 'message.create', id, content: 'Overwrite', role: 'user' })).rejects.toThrow();
  const otherChat = chats.createChatRaw('owner', { character_id: characterId }).id;
  await expect(writeRuntimeState('owner', otherChat, { kind: 'message.edit', id, content: 'Wrong chat' })).rejects.toThrow();
  expect(chats.getMessage('owner', id)?.content).toBe('System');
});

test('rolled back events do not advance revisions; a committed batch advances once', () => {
  const before = runtimeStateRevision('owner');
  expect(() => eventBus.withBufferedEvents(() => {
    eventBus.emit(EventType.MESSAGE_EDITED, {}, 'owner');
    throw new Error('rollback');
  })).toThrow('rollback');
  expect(runtimeStateRevision('owner')).toEqual(before);
  eventBus.emit(EventType.SPINDLE_BATCH_CHANGED, {}, 'owner');
  expect(runtimeStateRevision('owner').sequence).toBe(before.sequence + 1);
  expect(runtimeStateRevision('other').sequence).toBe(0);
});

test('deleting shared settings publishes a revision and clears the runtime value', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'owner'); await next(); });
  app.route('/settings', settingsRoutes);
  settings.putSetting('owner', 'macro_variables_global', { a: 'old' });
  settings.putSetting('other', 'macro_variables_global', { a: 'private' });
  const before = runtimeStateRevision('owner');
  const otherBefore = runtimeStateRevision('other');
  expect((await app.request('/settings/macro_variables_global', { method: 'DELETE' })).status).toBe(200);
  expect(runtimeStateRevision('owner').sequence).toBe(before.sequence + 1);
  expect(readRuntimeState('owner', chatId, characterId).globalVariables).toEqual({});
  expect(settings.getSetting('other', 'macro_variables_global')?.value).toEqual({ a: 'private' });
  expect(runtimeStateRevision('other')).toEqual(otherBefore);
  expect((await app.request('/settings/macro_variables_global', { method: 'DELETE' })).status).toBe(404);
  expect(runtimeStateRevision('owner').sequence).toBe(before.sequence + 1);
});

test('committed mutation events carry their exact acknowledgement identity and user scope', async () => {
  const seen: any[] = [];
  const remove = eventBus.on(EventType.CHAT_CHANGED, event => seen.push(event));
  try {
    const id = crypto.randomUUID();
    const result = await withRuntimeMutation('owner', id, () => writeRuntimeState('owner', chatId, { kind: 'chat.variables', values: { a: 'next' } }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(seen).toHaveLength(1);
    expect(seen[0].runtimeMutationId).toBe(id);
    expect(seen[0].stateRevision).toEqual(result.revision);
    withRuntimeMutation('other', id, () => eventBus.emit(EventType.CHAT_CHANGED, {}, 'owner'));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(seen[1].runtimeMutationId).toBeUndefined();
  } finally { remove(); }
});

test('the worker state API denies missing permissions and foreign chats before reading runtime data', async () => {
  const responses: any[] = [];
  let allow = false;
  const api = new WorkerHostStateApi({
    getChatOwnerId: id => id === chatId ? 'owner' : 'other',
    enforceScopedUser: id => { if (id !== 'owner') throw new Error('Wrong user'); },
    resolveEffectiveUserId: id => id ?? 'owner', hasPermission: () => allow,
    postResponse: message => responses.push(message),
  });
  api.dispatch({ type: 'runtime_state_read', requestId: 'denied', chatId, characterId });
  expect(responses[0].error).toContain('characters');
  allow = true;
  api.dispatch({ type: 'runtime_state_read', requestId: 'foreign', chatId: 'foreign', characterId });
  expect(responses[1].error).toContain('another user');
  api.dispatch({ type: 'runtime_state_read', requestId: 'allowed', chatId, characterId });
  expect(responses[2].result.chat.id).toBe(chatId);
});

test('runtime mutations return current records and deletion identifiers for each domain', async () => {
  const metadata = await writeRuntimeState('owner', chatId, { kind: 'chat.metadata', key: 'selected', value: 3 });
  expect(metadata.patch.chat).toMatchObject({ metadata: { preserved: 'value', selected: 3 } });
  const id = crypto.randomUUID();
  await writeRuntimeState('owner', chatId, { kind: 'message.create', id, content: 'Before', role: 'assistant' });
  expect((await writeRuntimeState('owner', chatId, { kind: 'message.edit', id, content: 'After' })).patch.message).toMatchObject({ id, content: 'After' });
  expect((await writeRuntimeState('owner', chatId, { kind: 'message.delete', id })).patch).toEqual({ deletedMessageId: id });
  expect(chats.getMessage('owner', id)).toBeNull();
  const character = await writeRuntimeState('owner', chatId, { kind: 'character.update', id: characterId, patch: { name: 'Updated' } });
  expect(character.patch.character).toMatchObject({ id: characterId, name: 'Updated' });
  expect(character.patch.character).not.toHaveProperty('extensions');
  const persona = personas.createPersona('owner', { name: 'Before' });
  expect((await writeRuntimeState('owner', chatId, { kind: 'persona.update', id: persona.id, patch: { description: 'Updated' } })).patch.persona).toMatchObject({ id: persona.id, name: 'Before', description: 'Updated' });
  const book = books.createWorldBook('owner', { name: 'Book' });
  const created = await writeRuntimeState('owner', chatId, { kind: 'lore.create', bookId: book.id, patch: { content: 'Before' } });
  const entry = created.patch.loreEntry as { id: string };
  expect((await writeRuntimeState('owner', chatId, { kind: 'lore.update', id: entry.id, patch: { content: 'After' } })).patch.loreEntry).toMatchObject({ id: entry.id, content: 'After' });
  vectorDeleteError = new Error('Vector store unavailable');
  await expect(writeRuntimeState('owner', chatId, { kind: 'lore.delete', id: entry.id })).rejects.toThrow('Vector store unavailable');
  expect(books.getEntry('owner', entry.id)?.content).toBe('After');
  vectorDeleteError = undefined;
  expect((await writeRuntimeState('owner', chatId, { kind: 'lore.delete', id: entry.id })).patch).toEqual({ deletedLoreId: entry.id });
  expect(books.getEntry('owner', entry.id)).toBeNull();
});

test('runtime mutations enforce permissions before changing state', () => {
  const responses: any[] = [];
  const api = new WorkerHostStateApi({
    getChatOwnerId: () => 'owner', enforceScopedUser() {}, resolveEffectiveUserId: () => 'owner',
    hasPermission: () => false, postResponse: message => responses.push(message),
  });
  for (const [kind, permission] of [
    ['chat.metadata', 'chats'], ['message.create', 'chat_mutation'], ['character.update', 'characters'],
    ['persona.update', 'personas'], ['lore.delete', 'world_books'],
  ]) {
    api.dispatch({ type: 'runtime_state_write', requestId: kind, chatId, command: { kind } });
    expect(responses.at(-1).error).toContain(permission);
  }
  expect(chats.getChat('owner', chatId)?.metadata).toEqual({ preserved: 'value', chat_variables: { a: '1' } });
});

test('runtime commands cannot modify another owners records', async () => {
  const foreignCharacter = characters.createCharacter('other', { name: 'Private' });
  const foreignPersona = personas.createPersona('other', { name: 'Private' });
  const foreignBook = books.createWorldBook('other', { name: 'Private' });
  const foreignEntry = books.createEntry('other', foreignBook.id, { content: 'Private' })!;
  await expect(writeRuntimeState('owner', chatId, { kind: 'character.update', id: foreignCharacter.id, patch: { name: 'Changed' } })).rejects.toThrow();
  await expect(writeRuntimeState('owner', chatId, { kind: 'persona.update', id: foreignPersona.id, patch: { name: 'Changed' } })).rejects.toThrow();
  await expect(writeRuntimeState('owner', chatId, { kind: 'lore.create', bookId: foreignBook.id, patch: { content: 'Changed' } })).rejects.toThrow();
  await expect(writeRuntimeState('owner', chatId, { kind: 'lore.update', id: foreignEntry.id, patch: { content: 'Changed' } })).rejects.toThrow();
  await expect(writeRuntimeState('owner', chatId, { kind: 'lore.delete', id: foreignEntry.id })).rejects.toThrow();
  expect(books.getEntry('other', foreignEntry.id)?.content).toBe('Private');
});
