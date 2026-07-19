import type { Chat } from "../types/chat";
import type { Character } from "../types/character";
import type { Persona } from "../types/persona";
import type { WorldBookEntry } from "../types/world-book";
import { getCharacterWorldBookIds } from "../utils/character-world-books";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as worldBooksSvc from "./world-books.service";

export type BookSource = "character" | "persona" | "chat" | "global" | "peer";
export type GroupCardMode = "swap" | "merge_ignore_muted" | "merge";
export type GroupLorebookMode = "follow_card_mode" | "active_character" | "all_unmuted" | "all";

export interface CollectWorldInfoSourcesOptions {
  chat?: Chat;
  groupCharacters?: Map<string, Character>;
}

export interface WorldInfoSources {
  entries: WorldBookEntry[];
  worldBookIds: string[];
  bookSourceMap: Map<string, BookSource>;
  bookNameMap: Map<string, string>;
}

export function getGroupCardMode(chat: Chat): GroupCardMode {
  const raw = chat.metadata?.group_card_mode;
  return raw === "merge_ignore_muted" || raw === "merge" ? raw : "swap";
}

export function getGroupLorebookMode(chat: Chat): GroupLorebookMode {
  const raw = chat.metadata?.group_lorebook_mode;
  return raw === "active_character" || raw === "all_unmuted" || raw === "all"
    ? raw
    : "follow_card_mode";
}

function resolveEffectiveGroupLorebookMode(chat: Chat): Exclude<GroupLorebookMode, "follow_card_mode"> {
  const mode = getGroupLorebookMode(chat);
  if (mode !== "follow_card_mode") return mode;

  switch (getGroupCardMode(chat)) {
    case "merge":
      return "all";
    case "merge_ignore_muted":
      return "all_unmuted";
    case "swap":
    default:
      return "active_character";
  }
}

function getOrderedGroupCharacterIds(chat: Chat): string[] {
  const rawIds = Array.isArray(chat.metadata?.character_ids)
    ? chat.metadata.character_ids
    : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of rawIds) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function resolveWorldInfoCharacters(
  userId: string,
  character: Character,
  chat?: Chat,
  groupCharacters?: Map<string, Character>,
): Character[] {
  if (chat?.metadata?.group !== true && chat?.metadata?.group !== 1) return [character];

  const mode = resolveEffectiveGroupLorebookMode(chat);
  if (mode === "active_character") return [character];

  const mutedIds = mode === "all_unmuted"
    ? new Set(chatsSvc.getGroupMutedIds(chat))
    : undefined;
  const memberIds = getOrderedGroupCharacterIds(chat).filter((id) => !mutedIds?.has(id));
  if (memberIds.length === 0) return [character];

  const fetchedCharacters = groupCharacters ?? charactersSvc.getCharactersByIds(userId, memberIds);
  const members = memberIds
    .map((id) => fetchedCharacters.get(id))
    .filter((member): member is Character => !!member);

  return members.length > 0 ? members : [character];
}

export function collectWorldInfoSources(
  userId: string,
  character: Character,
  persona: Persona | null,
  globalWorldBookIds?: string[],
  chatWorldBookIds?: string[],
  options?: CollectWorldInfoSourcesOptions,
): WorldInfoSources {
  const worldBookIds: string[] = [];
  const bookSourceMap = new Map<string, BookSource>();
  const bookNameMap = new Map<string, string>();
  const seen = new Set<string>();

  const pushBook = (id: string | null | undefined, source: BookSource) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    worldBookIds.push(id);
    bookSourceMap.set(id, source);
  };

  const sourceCharacters = resolveWorldInfoCharacters(
    userId,
    character,
    options?.chat,
    options?.groupCharacters,
  );
  const sourceCharactersById = new Map(sourceCharacters.map((sourceCharacter) => [sourceCharacter.id, sourceCharacter]));

  // Collect in priority order: character(s) -> persona -> chat -> global.
  // Source attribution keeps the first (narrowest) winner.
  for (const sourceCharacter of sourceCharacters) {
    for (const charBookId of getCharacterWorldBookIds(sourceCharacter.extensions)) {
      pushBook(charBookId, "character");
    }
  }
  pushBook(persona?.attached_world_book_id, "persona");
  for (const cId of chatWorldBookIds ?? []) pushBook(cId, "chat");
  for (const gId of globalWorldBookIds ?? []) pushBook(gId, "global");

  const entries: WorldBookEntry[] = [];
  if (worldBookIds.length > 0) {
    const entryMap = worldBooksSvc.listEntriesForBooks(userId, worldBookIds, bookNameMap);
    for (const id of worldBookIds) {
      const bookEntries = entryMap.get(id);
      if (bookEntries && bookEntries.length > 0) {
        entries.push(...bookEntries);
        continue;
      }

      const book = worldBooksSvc.getWorldBook(userId, id);
      const sourceCharacterId = typeof book?.metadata?.source_character_id === "string"
        ? book.metadata.source_character_id
        : "";
      const sourceCharacter = sourceCharactersById.get(sourceCharacterId);
      const embeddedCharacterBook = sourceCharacter?.extensions?.character_book;
      if (book?.metadata?.source === "character" && embeddedCharacterBook) {
        entries.push(
          ...worldBooksSvc.materializeCharacterBookEntriesForRuntime(
            id,
            embeddedCharacterBook,
          ),
        );
      }
    }
  }

  return {
    entries,
    worldBookIds,
    bookSourceMap,
    bookNameMap,
  };
}
