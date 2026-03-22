import { useMemo } from 'react'
import { useStore } from '@/store'
import { fromLeetSpeak } from '@/lib/leetSpeak'
import type { LumiaItem } from '@/types/api'

/**
 * Score how well a candidate name matches the target name.
 * Returns 0–100 — higher is better. 0 means no match.
 */
function getNameMatchScore(target: string, candidate: string): number {
  if (!target || !candidate) return 0

  const t = target.toLowerCase().trim()
  const c = candidate.toLowerCase().trim()

  // Exact match
  if (t === c) return 100

  // One contains the other
  if (c.includes(t) || t.includes(c)) return 80

  // Word-level matching
  const targetWords = t.split(/[\s_]+/)
  const candidateWords = c.split(/[\s_]+/)
  let matchedWords = 0
  for (const tw of targetWords) {
    if (tw.length < 2) continue
    if (candidateWords.some((cw) => cw === tw || cw.includes(tw) || tw.includes(cw))) {
      matchedWords++
    }
  }
  if (targetWords.length > 0 && matchedWords > 0) {
    return Math.round((matchedWords / targetWords.length) * 70)
  }

  return 0
}

/**
 * Sanitize a name that may use l33t encoding or underscore separation.
 * e.g. "lumia_serena" → "serena", "Lum1a" → "Lumia"
 */
function sanitizeName(raw: string): string {
  let name = raw.trim()
  // Strip common prefixes
  name = name.replace(/^lumia[_\s]+/i, '')
  // Basic l33t decode
  name = name
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
  return name
}

/**
 * Resolve a handle to its real name using l33tspeak reverse lookup against known members.
 * If the handle matches a member's toLeetSpeak(name), returns that member's real name.
 * Falls back to underscore→space conversion for non-leet handles.
 */
function resolveHandle(handle: string, memberNames: string[], useLeet: boolean): string {
  if (!handle) return handle
  if (useLeet) {
    const resolved = fromLeetSpeak(handle, memberNames)
    if (resolved) return resolved
  }
  // Non-leet mode or no match: treat underscores as spaces
  return handle.replace(/_/g, ' ')
}

interface AvatarResult {
  avatarUrl: string | null
  displayName: string
}

/**
 * Hook that resolves a Lumia name to an avatar URL using store data.
 * Lookup priority: council members → selected definition → all packs → fallback.
 * When ircUseLeetHandles is enabled, uses fromLeetSpeak for exact reverse lookup.
 */
export function useLumiaAvatar(name?: string): AvatarResult {
  const councilSettings = useStore((s) => s.councilSettings)
  const selectedDefinition = useStore((s) => s.selectedDefinition)
  const packsWithItems = useStore((s) => s.packsWithItems)
  const ircUseLeetHandles = useStore((s) => s.ircUseLeetHandles)
  const lumiaOOCStyle = useStore((s) => s.lumiaOOCStyle)

  return useMemo(() => {
    const fallbackName = selectedDefinition?.name ?? 'Lumia'
    if (!name) {
      return {
        avatarUrl: selectedDefinition?.avatar_url ?? null,
        displayName: fallbackName,
      }
    }

    const isIrc = lumiaOOCStyle === 'irc'
    const useLeet = isIrc && ircUseLeetHandles
    const memberNames = councilSettings.members.map((m) => m.itemName)

    // Try exact l33tspeak reverse lookup against council member names first
    const resolvedName = isIrc ? resolveHandle(name, memberNames, useLeet) : name
    const sanitized = sanitizeName(resolvedName)

    let bestScore = 0
    let bestAvatar: string | null = null
    let bestName = name

    const checkCandidate = (item: LumiaItem, nameToCheck: string) => {
      if (!item.avatar_url) return
      const score = getNameMatchScore(sanitized, nameToCheck)
      if (score > bestScore) {
        bestScore = score
        bestAvatar = item.avatar_url
        bestName = item.name
      }
    }

    // 1. Council members — find the matching member then look up its item
    for (const member of councilSettings.members) {
      const score = getNameMatchScore(sanitized, member.itemName)
      if (score > bestScore) {
        // Find the actual LumiaItem for avatar URL
        const packData = packsWithItems[member.packId]
        if (packData) {
          const item = packData.lumia_items.find((li) => li.id === member.itemId)
          if (item?.avatar_url) {
            bestScore = score
            bestAvatar = item.avatar_url
            bestName = item.name
          }
        }
      }
    }

    // 2. Selected definition
    if (selectedDefinition) {
      checkCandidate(selectedDefinition, selectedDefinition.name)
    }

    // 3. All packs
    for (const packData of Object.values(packsWithItems)) {
      for (const item of packData.lumia_items) {
        checkCandidate(item, item.name)
      }
    }

    // Accept matches with score >= 50
    if (bestScore >= 50 && bestAvatar) {
      return { avatarUrl: bestAvatar, displayName: bestName }
    }

    // Fallback to selected definition
    return {
      avatarUrl: selectedDefinition?.avatar_url ?? null,
      displayName: name || fallbackName,
    }
  }, [name, councilSettings.members, selectedDefinition, packsWithItems, ircUseLeetHandles, lumiaOOCStyle])
}
