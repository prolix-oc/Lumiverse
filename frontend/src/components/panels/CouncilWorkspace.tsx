import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import type { CouncilView } from '@/lib/council-navigation'
import { Spinner } from '@/components/shared/Spinner'
import CouncilManager from './CouncilManager'
import OOCPanel from './OOCPanel'
import CouncilFeedback from './CouncilFeedback'
import styles from './CouncilWorkspace.module.css'

const views: CouncilView[] = ['setup', 'feedback', 'ooc']

export default function CouncilWorkspace() {
  const { t } = useTranslation('panels')
  const view = useStore((s) => s.councilView)
  const setView = useStore((s) => s.setCouncilView)
  const settings = useStore((s) => s.councilSettings)
  const executing = useStore((s) => s.councilExecuting)
  const results = useStore((s) => s.councilToolResults)
  const executionResult = useStore((s) => s.councilExecutionResult)
  const [visited, setVisited] = useState<Set<CouncilView>>(() => new Set(['setup', view]))
  // Lazy-mount pages and retain their DOM so scroll and draft state survive switching.
  if (!visited.has(view)) setVisited(new Set([...visited, view]))

  return (
    <div className={styles.workspace}>
      <div className={styles.tabs} role="tablist" aria-label={t('councilWorkspace.navigation', { defaultValue: 'Council views' })}>
        {views.map((id, index) => (
          <button key={id} type="button" role="tab" id={`council-tab-${id}`} aria-controls={`council-view-${id}`} aria-selected={view === id} tabIndex={view === id ? 0 : -1} className={view === id ? styles.active : undefined}
            onClick={() => setView(id)} onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' ? views[(index + 1) % views.length] : event.key === 'ArrowLeft' ? views[(index + views.length - 1) % views.length] : event.key === 'Home' ? views[0] : event.key === 'End' ? views[views.length - 1] : undefined
              if (next) { event.preventDefault(); setView(next); document.getElementById(`council-tab-${next}`)?.focus() }
            }}>
            {t(`councilWorkspace.${id}`, { defaultValue: id === 'ooc' ? 'OOC' : id[0].toUpperCase() + id.slice(1) })}
            {id === 'feedback' && settings.councilMode && !executing && <span className={styles.enabledDot} role="img" aria-label={t('councilWorkspace.feedbackEnabled', { defaultValue: 'Council enabled; feedback active' })} title={t('councilWorkspace.feedbackEnabled', { defaultValue: 'Council enabled; feedback active' })}>●</span>}
            {id === 'feedback' && (executing ? <Spinner size={12} /> : results.length > 0 ? <span className={styles.badge}>{results.length}</span> : executionResult ? <span aria-label={t('councilWorkspace.completed', { defaultValue: 'Run completed' })}>●</span> : null)}
          </button>
        ))}
      </div>
      {views.filter((id) => visited.has(id)).map((id) => (
        <div key={id} className={styles.page} role="tabpanel" id={`council-view-${id}`} aria-labelledby={`council-tab-${id}`} hidden={view !== id} tabIndex={0}>
          {id === 'setup' ? <CouncilManager /> : id === 'ooc' ? <OOCPanel /> : <CouncilFeedback />}
        </div>
      ))}
    </div>
  )
}
