import { useMemo, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Search, ChevronDown, ChevronRight, AlertTriangle, User, Users, Globe, MessageSquare } from 'lucide-react'
import { IconUserStar } from '@tabler/icons-react'
import { useStore } from '@/store'
import type { ActivatedWorldInfoEntry } from '@/types/api'
import styles from './WorldInfoFeedback.module.css'

// 'peer' = a relayed multiplayer participant's attached persona lorebook.
const SCOPE_ORDER: Array<ActivatedWorldInfoEntry['bookSource']> = ['character', 'persona', 'peer', 'chat', 'global']
const SCOPE_ICONS: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  character: IconUserStar,
  persona: User,
  peer: Users,
  chat: MessageSquare,
  global: Globe,
}

export default function WorldInfoFeedback() {
  const { t } = useTranslation('panels', { keyPrefix: 'worldInfoFeedback' })
  const activatedWorldInfo = useStore((s) => s.activatedWorldInfo)
  const worldInfoStats = useStore((s) => s.worldInfoStats)
  const hasEntries = activatedWorldInfo.length > 0

  const keywordCount = activatedWorldInfo.filter((e) => e.source === 'keyword').length
  const vectorCount = activatedWorldInfo.filter((e) => e.source === 'vector').length

  const hasEvictions = worldInfoStats && (worldInfoStats.evictedByBudget > 0 || worldInfoStats.evictedByMinPriority > 0)

  const scopeLabel = (scope: string) => {
    const key = `scope.${scope}` as const
    return t(key, { defaultValue: scope })
  }

  const groupedByScope = useMemo(() => {
    const groups: Array<{ scope: string; label: string; entries: ActivatedWorldInfoEntry[] }> = []

    for (const scope of SCOPE_ORDER) {
      const entries = activatedWorldInfo.filter((e) => e.bookSource === scope)
      if (entries.length > 0) {
        groups.push({ scope: scope!, label: scopeLabel(scope!), entries })
      }
    }

    const untagged = activatedWorldInfo.filter((e) => !e.bookSource)
    if (untagged.length > 0) {
      groups.push({ scope: 'other', label: scopeLabel('other'), entries: untagged })
    }

    return groups
  }, [activatedWorldInfo, t])

  return (
    <div className={styles.container}>
      <div className={styles.statusBar}>
        {hasEntries ? (
          <div className={styles.statusComplete}>
            <BookOpen size={14} />
            <span>{t('activated', { count: worldInfoStats?.totalActivated ?? activatedWorldInfo.length })}</span>
            <span className={styles.entryCount}>
              {t('keywordVector', {
                keyword: worldInfoStats?.keywordActivated ?? keywordCount,
                vector: worldInfoStats?.vectorActivated ?? vectorCount,
              })}
            </span>
          </div>
        ) : (
          <div className={styles.statusIdle}>{t('idle')}</div>
        )}
      </div>

      {worldInfoStats && (
        <div className={hasEvictions ? styles.statsBarWarning : styles.statsBar}>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>{t('stats.candidates')}</span>
            <span className={styles.statValue}>{worldInfoStats.totalCandidates}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>{t('stats.activatedTotal')}</span>
            <span className={styles.statValue}>{worldInfoStats.totalActivated}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>{t('stats.keywordActivated')}</span>
            <span className={styles.statValue}>{worldInfoStats.keywordActivated}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>{t('stats.vectorActivated')}</span>
            <span className={styles.statValue}>{worldInfoStats.vectorActivated}</span>
          </div>
          {worldInfoStats.evictedByBudget > 0 && (
            <div className={styles.statsRow}>
              <AlertTriangle size={11} className={styles.warningIcon} />
              <span className={styles.statLabel}>{t('stats.evictedByBudget')}</span>
              <span className={styles.statValueWarn}>{worldInfoStats.evictedByBudget}</span>
            </div>
          )}
          {worldInfoStats.evictedByMinPriority > 0 && (
            <div className={styles.statsRow}>
              <AlertTriangle size={11} className={styles.warningIcon} />
              <span className={styles.statLabel}>{t('stats.belowMinPriority')}</span>
              <span className={styles.statValueWarn}>{worldInfoStats.evictedByMinPriority}</span>
            </div>
          )}
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>{t('stats.estTokens')}</span>
            <span className={styles.statValue}>{worldInfoStats.estimatedTokens.toLocaleString()}</span>
          </div>
          <div className={styles.statsRow}>
            <span className={styles.statLabel}>{t('stats.recursionPasses')}</span>
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
          {t('emptyHint')}
        </div>
      )}
    </div>
  )
}

function EntryCard({ entry }: { entry: ActivatedWorldInfoEntry }) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldInfoFeedback.entry' })
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
        <span className={styles.entryComment}>{entry.comment || t('unnamed')}</span>
        <span className={styles.methodBadge}>{entry.source}</span>
        {entry.source === 'vector' && entry.score != null && (
          <span className={styles.entryScore}>{t('distance', { score: entry.score.toFixed(3) })}</span>
        )}
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className={styles.entryContent}>
          {entry.keys.length > 0 && (
            <p className={styles.entryKeys}>
              <strong>{t('keys')}</strong> {entry.keys.join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
