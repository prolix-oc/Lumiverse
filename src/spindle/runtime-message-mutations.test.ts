import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../db/connection';
import * as chats from '../services/chats.service';
import { createCharacter } from '../services/characters.service';
import { writeRuntimeState, readRuntimeState } from './runtime-state';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';
import * as embeddings from '../services/embeddings.service';
import { assemblePrompt } from '../services/prompt-assembly.service';
import { createPreset } from '../services/presets.service';

test('runtime system-role edits reach legacy and Loom prompt history without assistant reasoning', async () => {
  const db = initDatabase(':memory:');
  const config = spyOn(embeddings, 'getEmbeddingConfig').mockResolvedValue({ enabled: false } as any);
  try {
    db.run('PRAGMA foreign_keys = OFF');
    db.run(await Bun.file(join(import.meta.dir, '../db/baseline.sql')).text());
    const userId = 'role-owner';
    const character = createCharacter(userId, { name: 'Character' });
    const chat = chats.createChatRaw(userId, { character_id: character.id });
    const message = chats.createMessage(chat.id, { is_user: false, name: 'Character', content: 'Role-edited content',
      extra: { reasoningCarrier: { type: 'gemini_thought_signature', signature: 'assistant-only' } } }, userId);
    await writeRuntimeState(userId, chat.id, { kind: 'message.edit', id: message.id, role: 'system' }, 'extension');
    const preset = createPreset(userId, { name: 'History', provider: 'openai', prompt_order: [{
      id: 'history', name: 'History', enabled: true, role: 'system', marker: 'chat_history', content: '',
      position: 'pre_history', depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null,
    }] });
    for (const presetId of [undefined, preset.id]) {
      const result = await assemblePrompt({ userId, chatId: chat.id, generationType: 'normal', presetId, macroCommit: false });
      const history = result.messages.find(row => row.content === message.content);
      expect(history?.role).toBe('system');
      expect(history).not.toHaveProperty('thought_signature');
    }
  } finally { await Bun.sleep(120); config.mockRestore(); closeDatabase(); }
});

test('runtime role changes and insertion preserve message identity, swipes, attachments and source times', async () => {
  const db = initDatabase(':memory:');
  const events: unknown[] = [];
  const cleanups: (() => void)[] = [];
  const config = spyOn(embeddings, 'getEmbeddingConfig').mockResolvedValue({ enabled: false } as any);
  try {
    db.run('PRAGMA foreign_keys = OFF');
    db.run(await Bun.file(join(import.meta.dir, '../db/baseline.sql')).text());
    const userId = 'owner';
    const character = createCharacter(userId, { name: 'Character' });
    const chat = chats.createChatRaw(userId, { character_id: character.id });
    const first = chats.createMessage(chat.id, { is_user: true, name: 'Speaker', content: 'Original',
      extra: { attachments: [{ type: 'image', image_id: 'kept' }], spindle_metadata: { other: { keep: true } } }, parent_message_id: 'parent', branch_id: 'branch' }, userId);
    chats.updateMessage(userId, first.id, { swipes: ['Original', 'Alternative'], swipe_dates: [11, 22] });
    const second = chats.createMessage(chat.id, { is_user: false, name: 'Character', content: 'Reply' }, userId);
    chats.updateChat(userId, chat.id, { metadata: { context_history_anchor_message_id: second.id, chat_variables: { keep: 'yes' } } });
    const before = chats.getMessages(userId, chat.id);
    await writeRuntimeState(userId, chat.id, { kind: 'message.edit', id: first.id, role: 'assistant' }, 'extension-a');
    const changed = chats.getMessage(userId, first.id)!;
    expect(changed).toMatchObject({ ...before[0]!, is_user: false, name: '', revision: (before[0] as any).revision + 1 });
    const insertedId = crypto.randomUUID();
    const inserted = await writeRuntimeState(userId, chat.id, { kind: 'message.create', id: insertedId, content: 'Inserted', role: 'user', beforeId: first.id, ownMetadata: { sentAt: 0 } }, 'extension-a');
    expect(inserted.patch.message).toMatchObject({ id: insertedId, index_in_chat: 0, ownMetadata: { sentAt: 0 } });
    expect(chats.getMessages(userId, chat.id).map(row => row.id)).toEqual([insertedId, first.id, second.id]);
    expect(chats.getMessage(userId, first.id)).toMatchObject({ ...changed, index_in_chat: 1, revision: (changed as any).revision + 1 });
    expect(chats.getMessage(userId, second.id)).toMatchObject({ ...before[1]!, index_in_chat: 2, revision: (before[1] as any).revision + 1 });
    expect(chats.getChat(userId, chat.id)!.metadata).toMatchObject({ context_history_anchor_message_id: second.id, chat_variables: { keep: 'yes' } });
    await writeRuntimeState(userId, chat.id, { kind: 'message.edit', id: first.id, ownMetadata: { sentAt: 0 } }, 'extension-a');
    expect(chats.getMessage(userId, first.id)!.extra.spindle_metadata).toEqual({ other: { keep: true }, 'extension-a': { sentAt: 0 } });
    const state = readRuntimeState(userId, chat.id, character.id, 'extension-a');
    expect(state.messages.find(row => row.id === first.id)?.ownMetadata).toEqual({ sentAt: 0 });
    expect(state.messages.find(row => row.id === first.id)?.extra).not.toHaveProperty('spindle_metadata');
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const event of [EventType.MESSAGE_SENT, EventType.MESSAGE_EDITED]) cleanups.push(eventBus.on(event, payload => events.push(payload)));
    const stable = chats.getMessages(userId, chat.id);
    await expect(writeRuntimeState(userId, chat.id, { kind: 'message.create', id: insertedId, content: 'Duplicate', role: 'user', beforeId: first.id }, 'extension-a')).rejects.toThrow();
    const foreign = chats.createChatRaw('mutation-foreign-owner', { character_id: character.id });
    const target = chats.createMessage(foreign.id, { content: 'Private', name: 'Other', is_user: true }, 'mutation-foreign-owner');
    await expect(writeRuntimeState(userId, chat.id, { kind: 'message.create', id: crypto.randomUUID(), content: 'Invalid', role: 'user', beforeId: target.id }, 'extension-a')).rejects.toThrow('Insertion target');
    expect(chats.getMessages(userId, chat.id)).toEqual(stable);
    await expect(writeRuntimeState(userId, chat.id, { kind: 'message.edit', id: first.id, ownMetadata: {} })).rejects.toThrow('namespace');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.filter((event: any) => event.payload?.chatId === chat.id)).toEqual([]);
  } finally { cleanups.forEach(cleanup => cleanup()); await Bun.sleep(120); config.mockRestore(); closeDatabase(); }
});

test('an insert sends one event however many rows move, and a same-side role edit keeps the name', async () => {
  const db = initDatabase(':memory:');
  const events: any[] = [];
  const cleanups: (() => void)[] = [];
  const config = spyOn(embeddings, 'getEmbeddingConfig').mockResolvedValue({ enabled: false } as any);
  try {
    db.run('PRAGMA foreign_keys = OFF');
    db.run(await Bun.file(join(import.meta.dir, '../db/baseline.sql')).text());
    const userId = 'owner';
    const character = createCharacter(userId, { name: 'Character' });
    const chat = chats.createChatRaw(userId, { character_id: character.id });
    const rows = Array.from({ length: 20 }, () => chats.createMessage(chat.id, { is_user: false, name: 'Character', content: 'Row' }, userId));
    await writeRuntimeState(userId, chat.id, { kind: 'message.edit', id: rows[1]!.id, role: 'system' }, 'extension-a');
    expect(chats.getMessage(userId, rows[1]!.id)!.name).toBe('Character');
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const event of [EventType.MESSAGE_SENT, EventType.MESSAGE_EDITED]) cleanups.push(eventBus.on(event, payload => events.push(payload)));
    const id = crypto.randomUUID();
    await writeRuntimeState(userId, chat.id, { kind: 'message.create', id, content: 'Inserted', role: 'user', beforeId: rows[0]!.id }, 'extension-a');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: EventType.MESSAGE_SENT, payload: { chatId: chat.id, inserted: true, message: { id, index_in_chat: 0 } } });
    expect(chats.getMessage(userId, rows[19]!.id)!.index_in_chat).toBe(20);
  } finally { cleanups.forEach(cleanup => cleanup()); await Bun.sleep(120); config.mockRestore(); closeDatabase(); }
});
