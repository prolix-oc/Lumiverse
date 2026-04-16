import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { settingsApi } from '@/api/settings'
import type { DreamWeaverSession } from '@/api/dream-weaver'
import styles from './DreamSidePanel.module.css'

interface DWGenParams {
  temperature?: number | null
  topP?: number | null
  maxTokens?: number | null
  topK?: number | null
  timeoutMs?: number | null
}

interface DreamSidePanelProps {
  session: DreamWeaverSession | null
  generating: boolean
  onUpdateSession: <K extends keyof Pick<DreamWeaverSession, 'dream_text' | 'tone' | 'constraints' | 'dislikes' | 'persona_id' | 'connection_id'>>(
    field: K,
    value: DreamWeaverSession[K],
  ) => void
  onDream: () => Promise<void>
}

export function DreamSidePanel({
  session,
  generating,
  onUpdateSession,
  onDream,
}: DreamSidePanelProps) {
  const canDream = Boolean(session?.dream_text?.trim()) && !generating
  const dreamLabel = session?.soul_state === 'ready' ? 'Dream Again' : 'Dream'
  const dreamIcon = session?.soul_state === 'ready' ? <RefreshCw size={16} /> : <Sparkles size={16} />

  const [llmExpanded, setLlmExpanded] = useState(true)
  const [genParams, setGenParams] = useState<DWGenParams>({})
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    settingsApi.get('dreamWeaverGenParams').then((row) => {
      if (row?.value && typeof row.value === 'object') {
        setGenParams(row.value as DWGenParams)
      }
    }).catch(() => {})
  }, [])

  const updateParam = useCallback(<K extends keyof DWGenParams>(key: K, value: DWGenParams[K]) => {
    setGenParams((prev) => {
      const next = { ...prev, [key]: value }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        settingsApi.put('dreamWeaverGenParams', next).catch(() => {})
      }, 500)
      return next
    })
  }, [])

  const helperText = useMemo(() => {
    if (session?.soul_state === 'ready') {
      return 'Edit the original dream, then Dream Again to rebuild Soul from that source.'
    }
    return 'Bootstrap the Soul draft from the original dream text and anti-slop guidance.'
  }, [session?.soul_state])

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Dream</h3>
        <p className={styles.subtitle}>{helperText}</p>
      </div>

      <label className={styles.label}>
        Dream Text
        <textarea
          className={styles.dreamInput}
          value={session?.dream_text ?? ''}
          onChange={(e) => onUpdateSession('dream_text', e.target.value)}
          placeholder="Describe the character or scenario you want to weave..."
          rows={9}
        />
      </label>

      <div className={styles.fieldGrid}>
        <label className={styles.label}>
          Tone
          <input
            className={styles.field}
            value={session?.tone ?? ''}
            onChange={(e) => onUpdateSession('tone', e.target.value || null)}
            placeholder="e.g. dry, intimate, urban"
          />
        </label>

        <label className={styles.label}>
          Avoid
          <input
            className={styles.field}
            value={session?.dislikes ?? ''}
            onChange={(e) => onUpdateSession('dislikes', e.target.value || null)}
            placeholder="tropes, style drift, clichés"
          />
        </label>
      </div>

      <div className={styles.llmSection}>
        <button
          type="button"
          className={styles.llmHeader}
          onClick={() => setLlmExpanded((v) => !v)}
        >
          <span>Generation Settings</span>
          <span className={styles.llmChevron} data-open={llmExpanded ? 'true' : undefined}>▼</span>
        </button>
        <p className={styles.llmHint}>
          Applies to every Dream Weaver generation. Leave blank to use step defaults.
        </p>

        {llmExpanded && (
          <div className={styles.llmGrid}>
            <label className={styles.llmField}>
              Temperature
              <input
                type="number"
                className={styles.llmInput}
                placeholder="Default"
                min={0}
                max={2}
                step={0.05}
                value={genParams.temperature ?? ''}
                onChange={(e) =>
                  updateParam('temperature', e.target.value !== '' ? parseFloat(e.target.value) : null)
                }
              />
            </label>

            <label className={styles.llmField}>
              Top P
              <input
                type="number"
                className={styles.llmInput}
                placeholder="Default"
                min={0}
                max={1}
                step={0.01}
                value={genParams.topP ?? ''}
                onChange={(e) =>
                  updateParam('topP', e.target.value !== '' ? parseFloat(e.target.value) : null)
                }
              />
            </label>

            <label className={styles.llmField}>
              Max Tokens
              <input
                type="number"
                className={styles.llmInput}
                placeholder="Default"
                min={256}
                step={256}
                value={genParams.maxTokens ?? ''}
                onChange={(e) =>
                  updateParam('maxTokens', e.target.value !== '' ? parseInt(e.target.value, 10) : null)
                }
              />
            </label>

            <label className={styles.llmField}>
              Top K
              <input
                type="number"
                className={styles.llmInput}
                placeholder="Default"
                min={1}
                step={1}
                value={genParams.topK ?? ''}
                onChange={(e) =>
                  updateParam('topK', e.target.value !== '' ? parseInt(e.target.value, 10) : null)
                }
              />
            </label>

            <label className={styles.llmField}>
              Timeout (s)
              <input
                type="number"
                className={styles.llmInput}
                placeholder="None"
                min={10}
                step={10}
                value={genParams.timeoutMs != null ? Math.round(genParams.timeoutMs / 1000) : ''}
                onChange={(e) =>
                  updateParam(
                    'timeoutMs',
                    e.target.value !== '' ? parseInt(e.target.value, 10) * 1000 : null,
                  )
                }
              />
            </label>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="primary" onClick={onDream} loading={generating} disabled={!canDream} icon={dreamIcon}>
          {dreamLabel}
        </Button>
      </div>
    </aside>
  )
}
