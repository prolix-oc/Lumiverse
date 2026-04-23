import { useEffect, useState, useCallback } from 'react'
import { PanelsLeftRight, Timer } from 'lucide-react'
import { useStore } from '@/store'
import { toast } from '@/lib/toast'
import styles from './SpindleSettings.module.css'

const DEFAULT_SECONDS = 10
const MIN_SECONDS = 1
const MAX_SECONDS = 300

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SECONDS
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(n)))
}

export default function SpindleSettings() {
  const spindleSettings = useStore((s) => s.spindleSettings)
  const setSetting = useStore((s) => s.setSetting)
  const [draft, setDraft] = useState<string>(String(DEFAULT_SECONDS))

  useEffect(() => {
    const ms = Number(spindleSettings.interceptorTimeoutMs)
    const value = Number.isFinite(ms) && ms > 0 ? clamp(ms / 1000) : DEFAULT_SECONDS
    setDraft(String(value))
  }, [spindleSettings.interceptorTimeoutMs])

  const commit = useCallback(async () => {
    const parsed = clamp(parseInt(draft, 10))
    setDraft(String(parsed))
    if (parsed === clamp(spindleSettings.interceptorTimeoutMs / 1000)) return
    setSetting('spindleSettings', {
      ...spindleSettings,
      interceptorTimeoutMs: parsed * 1000,
    })
    toast.success(`Extension interceptor timeout set to ${parsed}s`, { title: 'Spindle' })
  }, [draft, spindleSettings, setSetting])

  const updateDockSide = useCallback((dockPanelDesktopSide: 'left' | 'right') => {
    if (spindleSettings.dockPanelDesktopSide === dockPanelDesktopSide) return
    setSetting('spindleSettings', {
      ...spindleSettings,
      dockPanelDesktopSide,
    })
    toast.success(`Extension dock panels will open on the ${dockPanelDesktopSide}`, { title: 'Spindle' })
  }, [spindleSettings, setSetting])

  return (
    <div className={styles.card}>
      <div className={styles.headerRow}>
        <span className={styles.label}>
          <Timer size={12} /> Interceptor timeout
        </span>
        <div className={styles.inputGroup}>
          <input
            type="number"
            min={MIN_SECONDS}
            max={MAX_SECONDS}
            step={1}
            value={draft}
            className={styles.input}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          <span className={styles.suffix}>seconds</span>
        </div>
      </div>
      <p className={styles.hint}>
        How long to wait for an extension's pre-generation interceptor to finish. Higher values let
        extensions do heavier retrieval or context assembly before the LLM call at the cost of a
        longer delay before generation starts. Range {MIN_SECONDS}–{MAX_SECONDS}s (default {DEFAULT_SECONDS}s). Individual
        extensions can override this via their manifest.
      </p>

      <div className={styles.headerRow}>
        <span className={styles.label}>
          <PanelsLeftRight size={12} /> Dock panel side
        </span>
        <div className={styles.segmented}>
          <button
            type="button"
            className={styles.segmentedBtn}
            data-active={spindleSettings.dockPanelDesktopSide === 'left'}
            onClick={() => updateDockSide('left')}
          >
            Left
          </button>
          <button
            type="button"
            className={styles.segmentedBtn}
            data-active={spindleSettings.dockPanelDesktopSide === 'right'}
            onClick={() => updateDockSide('right')}
          >
            Right
          </button>
        </div>
      </div>
      <p className={styles.hint}>
        Side-mounted extension dock panels follow this desktop preference. On mobile, those same dock
        panels always collapse into a top sheet so they do not compete with the chat input area.
      </p>
    </div>
  )
}
