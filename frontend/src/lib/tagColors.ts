export const TAG_COLOR_SLOTS = 12
const PALETTE = [
  { bg: 'rgba(147, 112, 219, 0.15)', text: '#c4a8ff', border: 'rgba(147, 112, 219, 0.3)' },
  { bg: 'rgba(72, 160, 220, 0.15)', text: '#7ec8f0', border: 'rgba(72, 160, 220, 0.3)' },
  { bg: 'rgba(80, 200, 160, 0.15)', text: '#6edcb0', border: 'rgba(80, 200, 160, 0.3)' },
  { bg: 'rgba(240, 180, 80, 0.15)', text: '#f0c060', border: 'rgba(240, 180, 80, 0.3)' },
  { bg: 'rgba(220, 100, 120, 0.15)', text: '#e88098', border: 'rgba(220, 100, 120, 0.3)' },
  { bg: 'rgba(100, 180, 240, 0.15)', text: '#80c0f8', border: 'rgba(100, 180, 240, 0.3)' },
  { bg: 'rgba(200, 140, 220, 0.15)', text: '#d8a0e8', border: 'rgba(200, 140, 220, 0.3)' },
  { bg: 'rgba(120, 210, 200, 0.15)', text: '#88dcd0', border: 'rgba(120, 210, 200, 0.3)' },
  { bg: 'rgba(240, 150, 100, 0.15)', text: '#f0a878', border: 'rgba(240, 150, 100, 0.3)' },
  { bg: 'rgba(160, 200, 100, 0.15)', text: '#b0d870', border: 'rgba(160, 200, 100, 0.3)' },
  { bg: 'rgba(220, 160, 180, 0.15)', text: '#e0a8c0', border: 'rgba(220, 160, 180, 0.3)' },
  { bg: 'rgba(140, 170, 220, 0.15)', text: '#a0b8e0', border: 'rgba(140, 170, 220, 0.3)' },
] as const

const PALETTE_RGB = [
  '147, 112, 219',
  '72, 160, 220',
  '80, 200, 160',
  '240, 180, 80',
  '220, 100, 120',
  '100, 180, 240',
  '200, 140, 220',
  '120, 210, 200',
  '240, 150, 100',
  '160, 200, 100',
  '220, 160, 180',
  '140, 170, 220',
] as const

export interface TagColor {
  bg: string
  text: string
  border: string
}

const indexCache = new Map<string, number>()

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

const cache = new Map<string, TagColor>()

export function getTagColor(tag: string): TagColor {
  const cached = cache.get(tag)
  if (cached) return cached
  const index = indexCache.get(tag) ?? hashString(tag) % TAG_COLOR_SLOTS
  indexCache.set(tag, index)
  const color = PALETTE[index]
  cache.set(tag, color)
  return color
}

export function getTagColorVar(tag: string): string {
  const index = indexCache.get(tag) ?? hashString(tag) % TAG_COLOR_SLOTS
  indexCache.set(tag, index)
  return PALETTE_RGB[index]
}
