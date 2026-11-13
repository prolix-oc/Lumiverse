import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as settingsSvc from "./settings.service";
import * as worldBooksSvc from "./world-books.service";
import { getCharacterWorldBookIds } from "../utils/character-world-books";
import type { Chat } from "../types/chat";

/**
 * When world book attachments change, immediately prune wi_state entries
 * belonging to books that are no longer attached from any source. Without
 * this, orphaned sticky/cooldown state survives until the next generation's
 * activation cleanup — and the deferred WI state write from a concurrent
 * generation can restore it.
 *
 * Called after a chat's `chat_world_book_ids` metadata changes (REST metadata
 * patch, REST chat update, or a Spindle `chats.update`). Returns the chat with
 * the pruned metadata persisted, or the input chat unchanged when there was
 * nothing to prune.
 */
export function pruneOrphanedWiState(userId: string, chat: Chat): Chat {
  const wiState = chat.metadata?.wi_state as Record<string, any> | undefined;
  if (!wiState || Object.keys(wiState).length === 0) return chat;

  const character = chat.character_id ? charactersSvc.getCharacter(userId, chat.character_id) : null;
  const charBookIds = character ? getCharacterWorldBookIds(character.extensions) : [];
  const persona = personasSvc.resolvePersonaOrDefault(userId);
  const chatBookIds = (chat.metadata?.chat_world_book_ids as string[] | undefined) ?? [];
  const globalBookIds = (settingsSvc.getSetting(userId, "globalWorldBooks")?.value as string[] | undefined) ?? [];

  const allBookIds = new Set<string>();
  for (const id of charBookIds) allBookIds.add(id);
  if (persona?.attached_world_book_id) allBookIds.add(persona.attached_world_book_id);
  for (const id of chatBookIds) allBookIds.add(id);
  for (const id of globalBookIds) allBookIds.add(id);

  if (allBookIds.size === 0) {
    return chatsSvc.mergeChatMetadata(userId, chat.id, { wi_state: undefined }) ?? chat;
  }

  const entryMap = worldBooksSvc.listEntriesForBooks(userId, [...allBookIds]);
  const validUids = new Set<string>();
  for (const [, entries] of entryMap) {
    for (const e of entries) validUids.add(e.uid);
  }
  let pruned = false;
  for (const uid in wiState) {
    if (!validUids.has(uid)) {
      delete wiState[uid];
      pruned = true;
    }
  }
  if (!pruned) return chat;
  return chatsSvc.mergeChatMetadata(userId, chat.id, { wi_state: wiState }) ?? chat;
}
