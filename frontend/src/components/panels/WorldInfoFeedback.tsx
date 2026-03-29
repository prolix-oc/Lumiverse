import { useMemo, useState, type ComponentType } from 'react'
import { BookOpen, Search, ChevronDown, ChevronRight, AlertTriangle, User, Globe, MessageSquare } from 'lucide-react'
import { IconUserStar } from '@tabler/icons-react'
import { useStore } from '@/store'
import type { ActivatedWorldInfoEntry } from '@/types/api'
import styles from './WorldInfoFeedback.module.css'

const SCOPE_ORDER: Array<ActivatedWorldInfoEntry['bookSource']> = ['character', 'persona', 'chat', 'global']
const SCOPE_LABELS: Record<string, string> = {
  character: 'Character',
  persona: 'Persona',
  chat: 'This Chat',
  global: 'Global',
}
const SCOPE_ICONS: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  character: IconUserStar,
  persona: User,
  chat: MessageSquare,
  global: Globe,
}

export default function WorldInfoFeedback() {
  const activatedWorldInfo = useStore((s) => s.activatedWorldInfo)
  const worldInfoStats = useStore((s) => s.worldInfoStats)
  const hasEntries = activatedWorldInfo.length > 0

  const keywordCount = activatedWorldInfo.filter((e) => e.source === 'keyword').length
  const vectorCount = activatedWorldInfo.filter((e) => e.source === 'vector').length

  const hasEvictions = worldInfoStats && (worldInfoStats.evictedByBudget > 0 || worldInfoStats.evictedByMinPriority > 0)

  const groupedByScope = useMemo(() => {
    const groups: Array<{ scope: string; label: string; entries: ActivatedWorldInfoEntry[] }> = []

    for (const scope of SCOPE_ORDER) {
      const entries = activatedWorldInfo.filter((e) => e.bookSource === scope)
      if (entries.length > 0) {
        groups.push({ scope: scope!, label: SCOPE_LABELS[scope!], entries })
      }
    }

    // Entries without bookSource (backward compat) go into an "Other" group
    const untagged = activatedWorldInfo.filter((e) => !e.bookSource)
    if (untagged.length > 0) {
      groups.push({ scope: 'other', label: 'Other', entries: untagged })
    }

    return groups
  }, [activatedWorldInfo])

  return (
    <div className={styles.container}>
      <div className={styles.statusBar}>
        {hasEntries ? (
          <div className={styles.statusComplete}>
            <BookOpen size={14} />
            <span>{worldInfoStats?.totalActivated ?? activatedWorldInfo.length} entries activated</span>
            <span className={styles.entryCount}>
              {worldInfoStats?.keywordActivated ?? keywordCount} keyword, {worldInfoStats?.vectorActivated ?? vectorCount} vector
            </span>
          </div>
        ) : (
          <div className={styles.statusIdle}>No activated world info entries</div>
        )}
      </div>

      {worldInfoStats && (
        <div className={hasEvictions ? styles.statsBarWarning : styles.statsBar}>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>Candidates</span>
            <span className={styles.statValue}>{worldInfoStats.totalCandidates}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>Activated total</span>
            <span className={styles.statValue}>{worldInfoStats.totalActivated}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>Keyword activated</span>
            <span className={styles.statValue}>{worldInfoStats.keywordActivated}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>Vector activated</span>
            <span className={styles.statValue}>{worldInfoStats.vectorActivated}</span>
          </div>
          {worldInfoStats.evictedByBudget > 0 && (
            <div className={styles.statsRow}>
              <AlertTriangle size={11} className={styles.warningIcon} />
              <span className={styles.statLabel}>Evicted by budget</span>
              <span className={styles.statValueWarn}>{worldInfoStats.evictedByBudget}</span>
            </div>
          )}
          {worldInfoStats.evictedByMinPriority > 0 && (
            <div className={styles.statsRow}>
              <AlertTriangle size={11} className={styles.warningIcon} />
              <span className={styles.statLabel}>Below min priority</span>
              <span className={styles.statValueWarn}>{worldInfoStats.evictedByMinPriority}</span>
            </div>
          )}
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>Est. tokens</span>
            <span className={styles.statValue}>{worldInfoStats.estimatedTokens.toLocaleString()}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>Recursion passes</span>
            <span className={styles.statValue}>{worldInfoStats.recursionPassesUsed}</span>
          </div>
        </div>
      )}

      {groupedByScope.map((group) => {
        const ScopeIcon = SCOPE_ICONS[group.scope] ?? BookOpen
        return (
          <div key={group.scope} className={styles.sourceGroup}>
            <div className={styles.sourceHeader}>
              <ScopeIcon size={12} className={styles.scopeIcon} />
              <span className={styles.sourceName}>{group.label}</span>
              <span className={styles.sourceCount}>{group.entries.length}</span>
            </div>
            {group.entries.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )
      })}

      {!hasEntries && !worldInfoStats && (
        <div className={styles.emptyState}>
          Activated world info entries will appear here during generation when world books are attached.
        </div>
      )}
    </div>
  )
}

function EntryCard({ entry }: { entry: ActivatedWorldInfoEntry }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={styles.entryCard}>
      <button type="button" className={styles.entryHeader} onClick={() => setExpanded(!expanded)}>
        <span className={styles.entryIcon}>
          {entry.source === 'keyword' ? (
            <BookOpen size={12} className={styles.keywordIcon} />
          ) : (
            <Search size={12} className={styles.vectorIcon} />
          )}
        </span>
        <span className={styles.entryComment}>{entry.comment || '(unnamed)'}</span>
        <span className={styles.methodBadge}>{entry.source}</span>
        {entry.source === 'vector' && entry.score != null && (
          <span className={styles.entryScore}>dist: {entry.score.toFixed(3)}</span>
        )}
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className={styles.entryContent}>
          {entry.keys.length > 0 && (
            <p className={styles.entryKeys}>
              <strong>Keys:</strong> {entry.keys.join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
