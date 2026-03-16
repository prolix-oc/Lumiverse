export const GROUP_COLORS: Record<string, string> = {
  lumiverse: '#8a7fb0',
  chatHistory: '#d4a842',
  longTermMemory: '#e89b5f',
  worldInfo: '#68b87a',
  sidecar: '#e05daa',
  extensions: '#5bc0c0',
  system: '#5b8ca8',
}

export const BLOCK_PALETTE = [
  '#7c6fb0', '#b07c6f', '#6fb0a0', '#b0a06f', '#6f8db0', '#b06fa0',
  '#a0b06f', '#6fb0b0', '#b06f6f', '#6fb06f', '#8a6fb0', '#b08a6f',
]

export interface BreakdownEntry {
  name: string
  type: string
  tokens: number
  role?: string
  blockId?: string
}

export interface BreakdownGroup {
  label: string
  color: string
  tokens: number
  entries: BreakdownEntry[]
}

const TYPE_TO_GROUP: Record<string, string> = {
  block: 'lumiverse',
  chat_history: 'chatHistory',
  long_term_memory: 'longTermMemory',
  world_info: 'worldInfo',
  sidecar: 'sidecar',
  authors_note: 'extensions',
  separator: 'system',
  utility: 'system',
  append: 'lumiverse',
}

const GROUP_LABELS: Record<string, string> = {
  lumiverse: 'Lumiverse Prompts',
  chatHistory: 'Chat History',
  longTermMemory: 'Long-Term Memory',
  worldInfo: 'World Info',
  sidecar: 'Sidecar (Lumi Pipeline)',
  extensions: 'Extensions / Author\'s Note',
  system: 'System',
}

export function groupBreakdownEntries(entries: BreakdownEntry[]): BreakdownGroup[] {
  const groupMap = new Map<string, BreakdownGroup>()

  for (const entry of entries) {
    const groupKey = TYPE_TO_GROUP[entry.type] || 'system'
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        label: GROUP_LABELS[groupKey] || groupKey,
        color: GROUP_COLORS[groupKey] || GROUP_COLORS.system,
        tokens: 0,
        entries: [],
      })
    }
    const group = groupMap.get(groupKey)!
    group.tokens += entry.tokens
    group.entries.push(entry)
  }

  // Return in a stable order
  const order = ['lumiverse', 'chatHistory', 'longTermMemory', 'worldInfo', 'sidecar', 'extensions', 'system']
  const result: BreakdownGroup[] = []
  for (const key of order) {
    const g = groupMap.get(key)
    if (g) result.push(g)
  }
  return result
}

export function getBlockDisplayColor(index: number): string {
  return BLOCK_PALETTE[index % BLOCK_PALETTE.length]
}
