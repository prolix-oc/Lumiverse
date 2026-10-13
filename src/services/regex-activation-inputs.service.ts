import { createActivationInputSnapshot } from "../utils/regex-activation-inputs";
import { getEffectiveCharacterName, makeAssistantCharacter } from "../types/character";
import { isTemporaryChatMetadata } from "../types/chat";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as presetsSvc from "./presets.service";
import * as connectionsSvc from "./connections.service";
import { readActivationProfileVariables } from "./preset-profiles.service";

export interface ActivationPreviewContext {
  chat_id?: string;
  character_id?: string;
  persona_id?: string;
  connection_id?: string;
}

/** Owned, persisted inputs only. No prompt rendering, macro evaluation, or settings writes. */
export function loadActivationInputSnapshot(userId: string, presetId: string, context: ActivationPreviewContext = {}, patterns?: string[]) {
  for (const id of Object.values(context)) {
    if (id !== undefined && (typeof id !== "string" || !id || id.length > 200)) throw new Error("Invalid activation preview context ID");
  }
  const preset = presetsSvc.getPreset(userId, presetId);
  if (!preset) throw new Error("Linked prompt activation preset not found");
  const chat = context.chat_id ? chatsSvc.getChat(userId, context.chat_id) : null;
  if (context.chat_id && !chat) throw new Error("Activation chat not found");
  const characterId = context.character_id || chat?.character_id;
  const character = characterId ? charactersSvc.getCharacter(userId, characterId) : null;
  if (characterId && !character) throw new Error("Activation character not found");
  if (context.persona_id && !personasSvc.getPersona(userId, context.persona_id)) throw new Error("Activation persona not found");
  const persona = isTemporaryChatMetadata(chat?.metadata) ? null : personasSvc.resolvePersonaOrDefault(userId, context.persona_id);
  // Preview must not roll a random connection or perform a model request.
  const connection = context.connection_id ? connectionsSvc.getConnection(userId, context.connection_id) : connectionsSvc.getDefaultConnection(userId);
  if (context.connection_id && !connection) throw new Error("Activation connection not found");
  return createActivationInputSnapshot({
    characterName: getEffectiveCharacterName(character ?? makeAssistantCharacter()),
    userName: persona?.name || "User",
    chatVariables: chat?.metadata?.chat_variables,
    preset,
    patterns,
    profileValues: readActivationProfileVariables(userId, presetId, {
      chatId: chat?.id, characterId: character?.id, personaId: persona?.id,
      connectionId: connection?.id, isGroup: chat?.metadata?.group === true,
    }),
  });
}
