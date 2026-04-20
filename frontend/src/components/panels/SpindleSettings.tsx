import { useEffect, useState, useCallback } from 'react'
import { Timer } from 'lucide-react'
import { settingsApi } from '@/api/settings'
import { toast } from '@/lib/toast'
import styles from './SpindleSettings.module.css'

const KEY = 'spindleSettings'
const DEFAULT_SECONDS = 10
const MIN_SECONDS = 1
const MAX_SECONDS = 300

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SECONDS
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(n)))
}

export default function SpindleSettings() {
  const [seconds, setSeconds] = useState<number>(DEFAULT_SECONDS)
  const [draft, setDraft] = useState<string>(String(DEFAULT_SECONDS))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    settingsApi
      .get(KEY)
      .then((row) => {
        if (!alive) return
        const ms = Number(row?.value?.interceptorTimeoutMs)
        const value = Number.isFinite(ms) && ms > 0 ? clamp(ms / 1000) : DEFAULT_SECONDS
        setSeconds(value)
        setDraft(String(value))
      })
      .catch(() => {
        if (!alive) return
        setSeconds(DEFAULT_SECONDS)
        setDraft(String(DEFAULT_SECONDS))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const commit = useCallback(async () => {
    const parsed = clamp(parseInt(draft, 10))
    setDraft(String(parsed))
    if (parsed === seconds) return
    setSaving(true)
    try {
      await settingsApi.put(KEY, { interceptorTimeoutMs: parsed * 1000 })
      setSeconds(parsed)
      toast.success(`Extension interceptor timeout set to ${parsed}s`, { title: 'Spindle' })
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || 'Failed to save', { title: 'Spindle' })
      setDraft(String(seconds))
    } finally {
      setSaving(false)
    }
  }, [draft, seconds])

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
            disabled={loading || saving}
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
    </div>
  )
}
