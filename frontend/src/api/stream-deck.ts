import { del, get, post } from './client'

export type StreamDeckScope = 'characters:read' | 'chats:read'

export interface StreamDeckToken {
  id: string
  name: string
  token_prefix: string
  scopes: StreamDeckScope[]
  created_at: number
  last_used_at: number | null
  expires_at: number | null
}

export const streamDeckApi = {
  list: () => get<{ data: StreamDeckToken[] }>('/stream-deck/tokens'),
  create: (name: string) => post<StreamDeckToken & { token: string }>('/stream-deck/tokens', { name }),
  remove: (id: string) => del<{ success: true }>(`/stream-deck/tokens/${id}`),
}
