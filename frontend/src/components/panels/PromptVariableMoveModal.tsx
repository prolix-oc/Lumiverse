import { useMemo, useState } from 'react'
import { ChevronRight, CornerDownRight, Folder, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ModalShell } from '@/components/shared/ModalShell'
import type { PromptVariableDef } from '@/lib/loom/types'

import styles from './PromptVariableMoveModal.module.css'

export interface VariableMoveTarget {
  id: string
  name: string
  categoryId: string | null
  categoryName: string | null
  isCategory: boolean
  /** Trimmed variable names the target block already defines. */
  variableNames: string[]
}

interface VariableMoveGroup {
  key: string
  name: string
  categoryTarget?: VariableMoveTarget
  targets: VariableMoveTarget[]
}

interface PromptVariableMoveModalProps {
  variable: PromptVariableDef
  targets: VariableMoveTarget[]
  onMove: (targetBlockId: string) => void
  onClose: () => void
}

const UNCATEGORIZED_KEY = '__uncategorized__'

export default function PromptVariableMoveModal({
  variable,
  targets,
  onMove,
  onClose,
}: PromptVariableMoveModalProps) {
  const { t } = useTranslation('panels')
  const [search, setSearch] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())

  const variableName = variable.name?.trim() ?? ''
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const searching = normalizedSearch.length > 0

  const groups = useMemo<VariableMoveGroup[]>(() => {
    const byKey = new Map<string, VariableMoveGroup>()

    for (const target of targets) {
      const key = target.categoryId ?? UNCATEGORIZED_KEY
      let group = byKey.get(key)
      if (!group) {
        group = {
          key,
          name: target.categoryName || t('promptVariablesEditor.uncategorized'),
          targets: [],
        }
        byKey.set(key, group)
      }
      if (target.isCategory) group.categoryTarget = target
      else group.targets.push(target)
    }

    return [...byKey.values()]
  }, [targets, t])

  const visibleGroups = useMemo(() => {
    if (!searching) return groups

    return groups
      .map((group) => {
        const groupMatches = group.name.toLocaleLowerCase().includes(normalizedSearch)
        const filteredTargets = groupMatches
          ? group.targets
          : group.targets.filter((target) => target.name.toLocaleLowerCase().includes(normalizedSearch))
        return { ...group, targets: filteredTargets }
      })
      .filter((group) => Boolean(group.categoryTarget) || group.targets.length > 0)
  }, [groups, normalizedSearch, searching])

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <ModalShell
      isOpen
      onClose={onClose}
      maxWidth="min(620px, calc(100vw - 24px))"
      className={styles.modal}
    >
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <CornerDownRight size={17} />
        </div>
        <div className={styles.headerText}>
          <div className={styles.title}>{t('promptVariablesEditor.moveVariableTitle')}</div>
          <div className={styles.variableName}>{variableName || variable.label || variable.id}</div>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label={t('promptVariablesEditor.closeMovePicker')}
          title={t('promptVariablesEditor.closeMovePicker')}
        >
          <X size={16} />
        </button>
      </div>

      <div className={styles.searchWrap}>
        <Search size={15} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('promptVariablesEditor.searchBlocks')}
          autoFocus
        />
      </div>

      <div className={styles.tree}>
        {visibleGroups.length === 0 ? (
          <div className={styles.empty}>{t('promptVariablesEditor.noMatchingBlocks')}</div>
        ) : (
          visibleGroups.map((group) => {
            const open = searching || expandedGroups.has(group.key)
            return (
              <div key={group.key} className={styles.group}>
                <div className={styles.groupHeaderRow}>
                  <button
                    type="button"
                    className={styles.groupHeader}
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={open}
                  >
                    <ChevronRight size={14} className={open ? styles.chevronOpen : styles.chevron} />
                    <Folder size={14} className={styles.folderIcon} />
                    <span className={styles.groupName}>{group.name}</span>
                    <span className={styles.groupCount}>{group.targets.length}</span>
                  </button>

                  {group.categoryTarget && (() => {
                    const duplicate = Boolean(variableName)
                      && group.categoryTarget.variableNames.includes(variableName)
                    const disabled = !variableName || duplicate
                    return (
                      <button
                        type="button"
                        className={styles.groupMoveButton}
                        disabled={disabled}
                        onClick={() => onMove(group.categoryTarget!.id)}
                        aria-label={t('promptVariablesEditor.moveToBlock')}
                        title={duplicate
                          ? t('promptVariablesEditor.alreadyDefinesVariable', { name: variableName })
                          : t('promptVariablesEditor.moveToBlock')}
                      >
                        <CornerDownRight size={14} />
                      </button>
                    )
                  })()}
                </div>

                {open && (
                  <div className={styles.groupChildren}>
                    {group.targets.map((target) => {
                      const duplicate = Boolean(variableName) && target.variableNames.includes(variableName)
                      const disabled = !variableName || duplicate
                      return (
                        <button
                          key={target.id}
                          type="button"
                          className={styles.target}
                          disabled={disabled}
                          onClick={() => onMove(target.id)}
                        >
                          <CornerDownRight size={13} className={styles.targetIcon} />
                          <span className={styles.targetText}>
                            <span className={styles.targetName}>{target.name}</span>
                            {duplicate && (
                              <span className={styles.targetMeta}>
                                {t('promptVariablesEditor.alreadyDefinesVariable', { name: variableName })}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </ModalShell>
  )
}

