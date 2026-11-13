import { useEffect, useState } from 'react'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import type { RegexScript } from '@/types/regex'

interface ScriptEntry {
  scripts?: RegexScript[]
  promise: Promise<RegexScript[]>
}

const entries = new Map<string, ScriptEntry>()
const registryVersions = new WeakMap<RegexScript[], number>()
const EMPTY_SCRIPTS: RegexScript[] = []
const MAX_ENTRIES = 64
let nextRegistryVersion = 0

export function resetMessagePresetScriptsForTests(): void {
  entries.clear()
}

/** Share definitions across messages; registry replacement invalidates the source selection. */
export function useMessagePresetScripts(
  presetId: string | undefined,
  chatId: string | null,
  characterId: string | null,
  registry: RegexScript[],
) {
  let revision = presetId ? registryVersions.get(registry) : undefined
  if (presetId && revision === undefined) {
    revision = ++nextRegistryVersion
    registryVersions.set(registry, revision)
  }
  const key = presetId && chatId ? JSON.stringify([revision, chatId, characterId, presetId]) : null
  const [loaded, setLoaded] = useState<{ key: string; scripts: RegexScript[] } | null>(null)
  const cached = key ? entries.get(key)?.scripts : undefined

  useEffect(() => {
    if (!key || !presetId || !chatId) return
    let live = true
    let entry = entries.get(key)
    if (!entry) {
      const pending: ScriptEntry = { promise: Promise.resolve(EMPTY_SCRIPTS) }
      pending.promise = regexApi.getActive({
        preset_id: presetId, chat_id: chatId, character_id: characterId ?? undefined, target: 'display',
      }).then(scripts => {
        pending.scripts = scripts
        return scripts
      }).catch((error: unknown) => {
        // Release the row with fallback text, but let a remount retry a failed request.
        if (entries.get(key) === pending) entries.delete(key)
        console.error('[display] Could not load the selected swipe preset', error)
        toast.error(i18n.t('panels:regexPanel.presetLoadFailed', {
          defaultValue: 'Could not load this swipe’s preset regexes. Refresh to retry.',
        }))
        return EMPTY_SCRIPTS
      })
      entry = pending
      entries.set(key, entry)
      if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
    }
    void entry.promise.then(scripts => { if (live) setLoaded({ key, scripts }) })
    return () => { live = false }
  }, [key, presetId, chatId, characterId])

  const scripts = cached ?? (loaded?.key === key ? loaded.scripts : undefined)
  return { scripts: key ? scripts ?? EMPTY_SCRIPTS : undefined, ready: !key || scripts !== undefined }
}
