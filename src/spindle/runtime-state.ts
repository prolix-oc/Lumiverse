import * as chats from '../services/chats.service';
import * as characters from '../services/characters.service';
import * as personas from '../services/personas.service';
import * as settings from '../services/settings.service';
import * as books from '../services/world-books.service';
import { getCharacterWorldBookIds } from '../utils/character-world-books';
import { runtimeStateRevision } from './runtime-state-revision';
import type { Character } from '../types/character';
import type { Message } from '../types/message';
import type { RuntimeStateCommandDTO } from 'lumiverse-spindle-types';

export type RuntimeStateCommand = RuntimeStateCommandDTO;

export function projectRuntimeCharacter(character: Character) {
  const { extensions: _extensions, ...fields } = character;
  return { ...fields, world_book_ids: getCharacterWorldBookIds(character.extensions) };
}

export function projectRuntimeMessage(message: Message, metadataKey?: string | null) {
  const role: 'user' | 'system' | 'assistant' = message.is_user ? 'user' : message.extra?.spindle_role === 'system' ? 'system' : 'assistant';
  return { id: message.id, content: message.content, role, name: message.name,
    index_in_chat: message.index_in_chat, created_at: message.created_at, send_date: message.send_date,
    extra: { greeting_index: message.extra?.greeting_index },
    ...(metadataKey ? { ownMetadata: message.extra?.spindle_metadata?.[metadataKey] ?? null } : {}) };
}

export function readRuntimeState(userId: string, chatId: string, characterId: string, metadataKey?: string | null) {
  const chat = chats.getChat(userId, chatId);
  const character = characters.getCharacter(userId, characterId);
  if (!chat || !character) throw new Error('Runtime chat or character not found');
  const activePersonaId = settings.getSetting(userId, 'activePersonaId')?.value;
  const persona = typeof activePersonaId === 'string' ? personas.getPersona(userId, activePersonaId) : null;
  const worldBookIds = getCharacterWorldBookIds(character.extensions);
  // All reads are synchronous, so the revision describes this complete state without an interleaving write.
  return { revision: runtimeStateRevision(userId), chat, character: projectRuntimeCharacter(character), persona,
    messages: chats.getMessages(userId, chatId).map(message => projectRuntimeMessage(message, metadataKey)),
    lore: worldBookIds.flatMap(id => books.listEntries(userId, id)),
    globalVariables: settings.getSetting(userId, 'macro_variables_global')?.value ?? {} };
}

export async function writeRuntimeState(userId: string, chatId: string, command: RuntimeStateCommand, metadataKey?: string | null) {
  const chat = await chats.getChatAsync(userId, chatId);
  if (!chat) throw new Error('Runtime chat not found');
  let value: unknown;
  let patch: Record<string, unknown>;
  const messageExtra = (extra: Record<string, any>, role?: string, ownMetadata?: unknown) => {
    if (role !== undefined && !['system', 'assistant', 'user'].includes(role)) throw new Error('Invalid runtime message role');
    const result = { ...extra };
    if (role !== undefined) { if (role === 'system') result.spindle_role = role; else delete result.spindle_role; }
    if (ownMetadata !== undefined) {
      if (!metadataKey) throw new Error('Runtime message metadata requires an extension namespace');
      const bag = { ...result.spindle_metadata };
      if (ownMetadata === null) delete bag[metadataKey]; else bag[metadataKey] = ownMetadata;
      result.spindle_metadata = bag;
    }
    return result;
  };
  switch (command.kind) {
    case 'chat.metadata':
      value = await chats.mergeChatMetadataAsync(userId, chatId, { [command.key]: command.value });
      patch = { chat: value }; break;
    case 'chat.variables':
      value = await chats.mergeChatMetadataAsync(userId, chatId, { chat_variables: command.values }, { mergeObjectPaths: [["chat_variables"]] });
      patch = { chat: value }; break;
    case 'message.edit':
    case 'message.delete': {
      const message = chats.getMessage(userId, command.id);
      if (!message || message.chat_id !== chatId) throw new Error('Runtime message not found in this chat');
      if (command.kind === 'message.delete') {
        value = chats.deleteMessage(userId, command.id);
        patch = { deletedMessageId: command.id };
      } else {
        const updated = chats.updateMessage(userId, command.id, { content: command.content,
          // The stored name belongs to the old speaker. Runtime-created rows use an empty name too.
          ...(command.role !== undefined ? { is_user: command.role === 'user', ...((command.role === 'user') !== message.is_user ? { name: '' } : {}) } : {}),
          ...(command.role !== undefined || command.ownMetadata !== undefined ? { extra: messageExtra(message.extra, command.role, command.ownMetadata) } : {}) });
        if (!updated) throw new Error('Runtime message update failed');
        value = projectRuntimeMessage(updated, metadataKey); patch = { message: value };
      }
      break;
    }
    case 'message.create': {
      if (!['system', 'assistant', 'user'].includes(command.role)) throw new Error('Invalid runtime message role');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(command.id)) throw new Error('Invalid runtime message identifier');
      const message = chats.createMessage(chatId, { is_user: command.role === 'user', name: '', content: command.content,
        extra: messageExtra({}, command.role, command.ownMetadata) }, userId, command.id, command.beforeId, true);
      value = projectRuntimeMessage(message, metadataKey); patch = { message: value }; break;
    }
    case 'character.update': {
      const { name, description, first_mes } = command.patch;
      const updated = await characters.updateCharacterAsync(userId, command.id, { name, description, first_mes });
      if (!updated) throw new Error('Runtime character not found');
      value = projectRuntimeCharacter(updated); patch = { character: value }; break;
    }
    case 'persona.update': {
      const { name, description } = command.patch;
      value = (await personas.updatePersonaAsync(userId, command.id, { name, description }));
      if (!value) throw new Error('Runtime persona not found');
      patch = { persona: value }; break;
    }
    case 'lore.create':
      value = books.createEntry(userId, command.bookId, command.patch);
      if (!value) throw new Error('Runtime world book not found');
      patch = { loreEntry: value }; break;
    case 'lore.update':
      value = books.updateEntry(userId, command.id, command.patch);
      if (!value) throw new Error('Runtime lore entry not found');
      patch = { loreEntry: value }; break;
    case 'lore.delete':
      value = await books.deleteEntry(userId, command.id);
      if (!value) throw new Error('Runtime lore entry not found');
      patch = { deletedLoreId: command.id }; break;
    default: throw new Error('Unknown runtime state command');
  }
  return { revision: runtimeStateRevision(userId), value, patch };
}
