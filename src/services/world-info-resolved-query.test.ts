import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../db/connection';
import { createCharacter } from './characters.service';
import { createPersona } from './personas.service';
import { createChat, createMessage, getChat, updateChat } from './chats.service';
import { createWorldBook, createEntry } from './world-books.service';
import { createPreset } from './presets.service';
import { createConnection } from './connections.service';
import { putSetting } from './settings.service';
import { setCharacterWorldBookIds } from '../utils/character-world-books';
import { worldInfoInterceptorChain } from '../spindle/world-info-interceptor';
import { assemblePrompt, getResolvedWorldInfoForChat } from './prompt-assembly.service';
import { WorkerHostContentApi } from '../spindle/worker-host-content-api';
import { macroInterceptorChain } from '../spindle/macro-interceptor';

test('resolved lore uses native activation, budget, roles and chat context without committing macro or native WI state', async () => {
  const db = initDatabase(':memory:');
  let unregister = () => {};
  let unregisterMacro = () => {};
  try {
    db.run('PRAGMA foreign_keys = OFF');
    db.run(await Bun.file(join(import.meta.dir, '../db/baseline.sql')).text());
    const userId = 'lore-owner';
    const book = createWorldBook(userId, { name: 'Lore' });
    const first = createEntry(userId, book.id, { key: ['match'], content: 'First {{char}} {{user}}', role: 'assistant', order_value: 100, priority: 100, sticky: 2 })!;
    const second = createEntry(userId, book.id, { key: ['match'], content: 'Second', role: 'user', order_value: 200, priority: 200 })!;
    createEntry(userId, book.id, { key: ['absent'], content: 'Unmatched' });
    createEntry(userId, book.id, { constant: true, disabled: true, content: 'Disabled' });
    createEntry(userId, book.id, { key: ['match'], content: 'Too expensive '.repeat(1000), priority: 1 });
    const character = createCharacter(userId, { name: 'Aurora', extensions: setCharacterWorldBookIds({}, [book.id]) });
    createPersona(userId, { name: 'Morgan', is_default: true });
    const chat = createChat(userId, { character_id: character.id });
    createMessage(chat.id, { is_user: true, name: 'Morgan', content: 'match' }, userId);
    putSetting(userId, 'worldInfoSettings', { maxTokenBudget: 40 });
    const metadata = structuredClone(getChat(userId, chat.id)!.metadata);
    const purposes: unknown[] = [];
    unregister = worldInfoInterceptorChain.register({ extensionId: 'resolver', userId, priority: 100, handler: async ctx => {
      purposes.push(ctx.purpose);
      return { mutated: [{ id: first.id, content: 'Resolved {{char}} {{user}} {{setchatvar::queryWrite::yes}}', selectionContent: 'Resolved', outputOrder: 'insertion' },
        { id: second.id, outputOrder: 'insertion', placement: { type: 'chat_depth', depth: 0, direction: 'from_end', role: 'user' } }] };
    } });
    const expected = [{ content: 'Resolved Aurora Morgan', role: 'assistant' as const }, { content: 'Second', role: 'user' as const }];
    expect(await getResolvedWorldInfoForChat(userId, chat.id)).toEqual(expected);
    expect(purposes).toEqual(['query']);
    expect(await getResolvedWorldInfoForChat(userId, chat.id, 1_000_000)).toEqual(expected);
    purposes.length = 0;
    expect(getChat(userId, chat.id)!.metadata).toEqual(metadata);
    const preset = createPreset(userId, { name: 'Actual preset', provider: 'openai', prompt_order: [{
      id: 'history', name: 'History', enabled: true, role: 'system', marker: 'chat_history', content: '',
      position: 'pre_history', depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null,
    }], parameters: { samplerOverrides: { enabled: true, contextSize: 20 } } });
    const defaultConnection = await createConnection(userId, { name: 'Test', provider: 'openai', api_url: '', model: '', is_default: true, preset_id: preset.id });
    const presets: unknown[] = [];
    unregisterMacro = macroInterceptorChain.register({ extensionId: 'context', userId, priority: 0, handler: async ctx => {
      presets.push(ctx.env.extra.presetId);
      expect(ctx.commit).toBe(false);
    } });
    expect(await getResolvedWorldInfoForChat(userId, chat.id)).toEqual(expected);
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.every(id => id === preset.id)).toBe(true);
    expect(await getResolvedWorldInfoForChat(userId, chat.id, 21)).toEqual([]);
    expect(await getResolvedWorldInfoForChat(userId, chat.id, -1000)).toEqual(expected);
    await expect(getResolvedWorldInfoForChat(userId, chat.id, NaN)).rejects.toThrow('reserve');
    await expect(getResolvedWorldInfoForChat('other-user', chat.id)).rejects.toThrow('Chat not found');
    const assembled = await assemblePrompt({ userId, chatId: chat.id, generationType: 'normal', macroCommit: false, skipPromptRegex: true });
    expect(purposes.at(-1)).toBe('prompt');
    expect(assembled.messages.filter(row => typeof row.content === 'string' && (row.content.startsWith('Resolved') || row.content === 'Second'))
      .map(row => ({ content: (row.content as string).trim(), role: row.role }))).toEqual(expected);
    const response = await new Promise<any>(resolve => {
      const api = new WorkerHostContentApi({ manifest: { identifier: 'query' }, hasPermission: () => false,
        resolveEffectiveUserId: () => userId, enforceScopedUser: () => {}, postResponse: resolve });
      void api.handleWorldBooksResolveForChat('denied', chat.id);
    });
    expect(response.error).toContain('world_books');
    const worldBooksOnly = await new Promise<any>(resolve => {
      const api = new WorkerHostContentApi({ manifest: { identifier: 'query' }, hasPermission: permission => permission === 'world_books',
        resolveEffectiveUserId: () => userId, enforceScopedUser: () => {}, postResponse: resolve });
      void api.handleWorldBooksResolveForChat('no-chats', chat.id);
    });
    expect(worldBooksOnly.error).toContain('chats');
    const success = await new Promise<any>(resolve => {
      const api = new WorkerHostContentApi({ manifest: { identifier: 'query' }, hasPermission: () => true,
        resolveEffectiveUserId: () => userId, enforceScopedUser: actual => expect(actual).toBe(userId), postResponse: resolve });
      void api.handleWorldBooksResolveForChat('allowed', chat.id);
    });
    expect(success.result).toEqual(expected);
    const activePreset = createPreset(userId, { name: 'Active', provider: 'openai', parameters: { samplerOverrides: { enabled: true, contextSize: 200 } } });
    const activeConnection = await createConnection(userId, { name: 'Active', provider: 'openai', api_url: '', model: '', preset_id: activePreset.id });
    putSetting(userId, 'activeProfileId', activeConnection.id);
    expect(await getResolvedWorldInfoForChat(userId, chat.id, 21)).toEqual(expected);
    expect(presets.at(-1)).toBe(activePreset.id);
    updateChat(userId, chat.id, { metadata: { ...metadata, connection_profile_id: defaultConnection.id, connection_model: 'pinned-model' } });
    expect(await getResolvedWorldInfoForChat(userId, chat.id, 21)).toEqual([]);
  } finally { unregister(); unregisterMacro(); closeDatabase(); }
});

test('resolved lore restores literal text and applies chat persona addon choices', async () => {
  const db = initDatabase(':memory:');
  try {
    db.run('PRAGMA foreign_keys = OFF');
    db.run(await Bun.file(join(import.meta.dir, '../db/baseline.sql')).text());
    const userId = 'literal-owner';
    const book = createWorldBook(userId, { name: 'Literal lore' });
    createEntry(userId, book.id, { constant: true, content: '{{#escape}}{{char}}{{/escape}}', role: 'system', order_value: 200 });
    createEntry(userId, book.id, { constant: true, content: '{{persona}}', role: 'user', order_value: 100 });
    const character = createCharacter(userId, { name: 'Aurora', extensions: setCharacterWorldBookIds({}, [book.id]) });
    const persona = createPersona(userId, { name: 'Morgan', description: 'Base persona', is_default: true,
      metadata: { addons: [{ id: 'addon', label: '', content: 'Excluded', enabled: true, sort_order: 0 }] } });
    const chat = createChat(userId, { character_id: character.id, metadata: { persona_addon_states: { [persona.id]: { addon: false } } } });
    expect(await getResolvedWorldInfoForChat(userId, chat.id)).toEqual([
      { content: 'Base persona', role: 'user' }, { content: '{{char}}', role: 'system' },
    ]);
  } finally { closeDatabase(); }
});
