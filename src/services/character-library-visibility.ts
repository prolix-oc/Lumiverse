import { LUMIVERSE_LIBRARY_HIDDEN_KEY, MULTIPLAYER_ROOMS_CHARACTER_NAME } from "../types/character";

/** Shared by list filtering and multiplayer container reuse. Aliases are host-owned SQL identifiers. */
export function libraryHiddenCharacterSqlPredicate(alias = "characters"): { sql: string; params: string[] } {
  return {
    sql: `(
      COALESCE(json_extract(${alias}.extensions, '$.${LUMIVERSE_LIBRARY_HIDDEN_KEY}'), 0) IN (1, 'true')
      OR (
        ${alias}.name = ?
        AND EXISTS (
          SELECT 1 FROM chats shadow
          WHERE shadow.character_id = ${alias}.id AND shadow.user_id = ${alias}.user_id
            AND json_extract(shadow.metadata, '$.multiplayer') = 1
            AND json_type(shadow.metadata, '$.joined_room') = 'object'
        )
      )
    )`,
    params: [MULTIPLAYER_ROOMS_CHARACTER_NAME],
  };
}
