import { get, put } from './client'

/**
 * Per-character connection bindings ("bind to char"). `GET` is 200-with-null
 * when unbound (only an unknown character 404s); `PUT` with `null` clears.
 */
export interface CharacterConnectionBind {
  connection_id: string | null
}

export const characterConnectionBindsApi = {
  get(characterId: string) {
    return get<CharacterConnectionBind>(`/character-connection-binds/${characterId}`)
  },

  put(characterId: string, connectionId: string | null) {
    return put<CharacterConnectionBind>(`/character-connection-binds/${characterId}`, {
      connection_id: connectionId,
    })
  },
}
