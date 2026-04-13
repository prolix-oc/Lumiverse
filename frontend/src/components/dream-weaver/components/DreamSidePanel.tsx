import { useMemo } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import type { DreamWeaverSession } from '@/api/dream-weaver'
import styles from './DreamSidePanel.module.css'

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

      <div className={styles.actions}>
        <Button variant="primary" onClick={onDream} loading={generating} disabled={!canDream} icon={dreamIcon}>
          {dreamLabel}
        </Button>
      </div>
    </aside>
  )
}
