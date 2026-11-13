import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { ChevronLeft, ChevronDown, ChevronRight, Plus, Pencil, Trash2, Settings, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { packsApi } from '@/api/packs'
import { useStore } from '@/store'
import LazyImage from '@/components/shared/LazyImage'
import { Button } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import LumiaEditorModal from './LumiaEditorModal'
import LoomItemEditorModal from './LoomItemEditorModal'
import type { PackWithItems, LumiaItem, LoomItem } from '@/types/api'
import styles from './PackBrowser.module.css'
import clsx from 'clsx'

interface Props {
  pack: PackWithItems
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
  onRefresh: () => void
}

function genderShortLabel(gender: number, t: (key: string) => string): string {
  if (gender === 0) return t('creatorWorkshop.shared.gender.shortFem')
  if (gender === 1) return t('creatorWorkshop.shared.gender.shortMasc')
  if (gender === 2) return t('creatorWorkshop.shared.gender.shortNeutral')
  return t('creatorWorkshop.shared.gender.shortAny')
}

function categoryLabel(category: string, t: (key: string) => string): string {
  if (category === 'narrative_style') return t('creatorWorkshop.shared.category.style')
  if (category === 'loom_utility') return t('creatorWorkshop.shared.category.utility')
  if (category === 'retrofit') return t('creatorWorkshop.shared.category.retrofit')
  return category
}

type PreviewTab = 'def' | 'pers' | 'behav'

function LumiaRow({
  item,
  isCustom,
  onEdit,
  onDelete,
}: {
  item: LumiaItem
  isCustom: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewTab, setPreviewTab] = useState<PreviewTab>('def')

  const tabs = [
    item.definition ? { id: 'def' as PreviewTab, label: t('packBrowser.previewTabDef') } : null,
    item.personality ? { id: 'pers' as PreviewTab, label: t('packBrowser.previewTabPers') } : null,
    item.behavior ? { id: 'behav' as PreviewTab, label: t('packBrowser.previewTabBehav') } : null,
  ].filter((tab): tab is { id: PreviewTab; label: string } => tab !== null)

  const hasContent = tabs.length > 0
  const effectiveTab = tabs.find((t) => t.id === previewTab) ? previewTab : (tabs[0]?.id ?? 'def')

  const contentMap: Record<PreviewTab, string | undefined> = {
    def: item.definition || undefined,
    pers: item.personality || undefined,
    behav: item.behavior || undefined,
  }

  return (
    <div className={styles.lumiaEntry}>
      <div className={styles.lumiaCard}>
        <LazyImage
          src={item.avatar_url}
          alt={item.name}
          containerClassName={styles.lumiaAvatar}
          spinnerSize={14}
          fallback={<div className={styles.lumiaAvatarFallback}>{item.name.charAt(0)}</div>}
        />
        <div className={styles.lumiaInfo}>
          <div className={styles.lumiaName}>{item.name}</div>
          {item.author_name && <div className={styles.lumiaAuthor}>{item.author_name}</div>}
        </div>
        <span className={styles.genderBadge}>{genderShortLabel(item.gender_identity, t)}</span>
        {hasContent && (
          <Button
            size="icon-sm"
            variant="ghost"
            className={previewOpen ? styles.itemActionBtnActive : undefined}
            onClick={() => setPreviewOpen((o) => !o)}
            title={previewOpen ? t('packBrowser.hidePreview') : t('packBrowser.previewContent')}
            icon={previewOpen ? <EyeOff size={11} /> : <Eye size={11} />}
          />
        )}
        {isCustom && (
          <div className={styles.itemActions}>
            <Button size="icon-sm" variant="ghost" onClick={onEdit} title={tc('actions.edit')} icon={<Pencil size={11} />} />
            <Button size="icon-sm" variant="danger-ghost" onClick={onDelete} title={tc('actions.delete')} icon={<Trash2 size={11} />} />
          </div>
        )}
      </div>
      {previewOpen && hasContent && (
        <div className={styles.lumiaPreviewPanel}>
          {tabs.length > 1 && (
            <div className={styles.lumiaPreviewTabs}>
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={clsx(styles.lumiaPreviewTab, effectiveTab === tab.id && styles.lumiaPreviewTabActive)}
                  onClick={() => setPreviewTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          <div className={styles.lumiaPreviewContent}>
            <pre className={styles.lumiaPreviewText}>{contentMap[effectiveTab] || ''}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

export default function PackDetailView({
 pack, onBack, onEdit, onDelete, onRefresh }: Props) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const loadAvailableTools = useStore((s) => s.loadAvailableTools)
  const [lumiaOpen, setLumiaOpen] = useState(true)
  const [loomOpen, setLoomOpen] = useState(true)
  const [toolsOpen, setToolsOpen] = useState(true)

  const [editingLumia, setEditingLumia] = useState<LumiaItem | null>(null)
  const [showLumiaEditor, setShowLumiaEditor] = useState(false)
  const [editingLoomItem, setEditingLoomItem] = useState<LoomItem | null>(null)
  const [showLoomEditor, setShowLoomEditor] = useState(false)

  const [deleteConfirm, setDeleteConfirm] = useState<{ type: string; id: string } | null>(null)
  const [deletePackConfirm, setDeletePackConfirm] = useState(false)
  const [repairConfirm, setRepairConfirm] = useState(false)

  const handleDeleteItem = useCallback(async () => {
    if (!deleteConfirm) return
    try {
      if (deleteConfirm.type === 'lumia') {
        await packsApi.deleteLumiaItem(pack.id, deleteConfirm.id)
      } else if (deleteConfirm.type === 'loom') {
        await packsApi.deleteLoomItem(pack.id, deleteConfirm.id)
      } else if (deleteConfirm.type === 'tool') {
        await packsApi.deleteLoomTool(pack.id, deleteConfirm.id)
        void loadAvailableTools()
      }
      setDeleteConfirm(null)
      onRefresh()
    } catch {}
  }, [deleteConfirm, pack.id, onRefresh, loadAvailableTools])

  const handleRepairLegacyGenderMapping = useCallback(async () => {
    try {
      await packsApi.repairOldLumiverseGenderMapping(pack.id)
      setRepairConfirm(false)
      onRefresh()
    } catch {}
  }, [pack.id, onRefresh])

  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <Button size="sm" variant="ghost" onClick={onBack} icon={<ChevronLeft size={13} />}>
          {t('packBrowser.back')}
        </Button>
        <div className={styles.detailMeta}>
          <div className={styles.detailName}>{pack.name}</div>
          {pack.author && <div className={styles.detailAuthor}>{t('packBrowser.byAuthor', { author: pack.author })}</div>}
        </div>
        <div className={styles.detailActions}>
          {pack.lumia_items.length > 0 && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setRepairConfirm(true)}
              title={t('packBrowser.repairGenderTitle')}
              icon={<RefreshCw size={14} />}
            />
          )}
          {pack.is_custom && (
            <Button size="icon" variant="ghost" onClick={onEdit} title={t('packBrowser.editPack')} icon={<Settings size={14} />} />
          )}
          <Button
            size="icon"
            variant="danger-ghost"
            onClick={() => setDeletePackConfirm(true)}
            title={t('packBrowser.deletePack')}
            icon={<Trash2 size={14} />}
          />
        </div>
      </div>

      <div className={styles.detailBody}>
        {/* Lumia Items */}
        <div className={styles.section}>
          <div className={styles.sectionHeader} onClick={() => setLumiaOpen((o) => !o)}>
            {lumiaOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className={styles.sectionTitle}>{t('packBrowser.lumiaCharacters')}</span>
            <span className={styles.sectionCount}>{pack.lumia_items.length}</span>
            {pack.is_custom && (
              <button
                type="button"
                className={styles.sectionAddBtn}
                onClick={(e) => { e.stopPropagation(); setEditingLumia(null); setShowLumiaEditor(true) }}
              >
                <Plus size={11} />
                {t('packBrowser.add')}
              </button>
            )}
          </div>
          {lumiaOpen && (
            <div className={styles.sectionContent}>
              {pack.lumia_items.map((item) => (
                <LumiaRow
                  key={item.id}
                  item={item}
                  isCustom={pack.is_custom}
                  onEdit={() => { setEditingLumia(item); setShowLumiaEditor(true) }}
                  onDelete={() => setDeleteConfirm({ type: 'lumia', id: item.id })}
                />
              ))}
              {pack.lumia_items.length === 0 && (
                <div className={styles.emptyState}>{t('packBrowser.noCharacters')}</div>
              )}
            </div>
          )}
        </div>

        {/* Loom Items */}
        <div className={styles.section}>
          <div className={styles.sectionHeader} onClick={() => setLoomOpen((o) => !o)}>
            {loomOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className={styles.sectionTitle}>{t('packBrowser.loomItems')}</span>
            <span className={styles.sectionCount}>{pack.loom_items.length}</span>
            {pack.is_custom && (
              <button
                type="button"
                className={styles.sectionAddBtn}
                onClick={(e) => { e.stopPropagation(); setEditingLoomItem(null); setShowLoomEditor(true) }}
              >
                <Plus size={11} />
                {t('packBrowser.add')}
              </button>
            )}
          </div>
          {loomOpen && (
            <div className={styles.sectionContent}>
              {pack.loom_items.map((item) => (
                <div key={item.id} className={styles.loomRow}>
                  <div className={styles.loomName}>{item.name}</div>
                  <span className={styles.categoryBadge}>{categoryLabel(item.category, t)}</span>
                  {pack.is_custom && (
                    <div className={styles.itemActions}>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => { setEditingLoomItem(item); setShowLoomEditor(true) }}
                        title={tc('actions.edit')}
                        icon={<Pencil size={11} />}
                      />
                      <Button
                        size="icon-sm"
                        variant="danger-ghost"
                        onClick={() => setDeleteConfirm({ type: 'loom', id: item.id })}
                        title={tc('actions.delete')}
                        icon={<Trash2 size={11} />}
                      />
                    </div>
                  )}
                </div>
              ))}
              {pack.loom_items.length === 0 && (
                <div className={styles.emptyState}>{t('packBrowser.noLoomItems')}</div>
              )}
            </div>
          )}
        </div>

        {/* Loom Tools */}
        <div className={styles.section}>
          <div className={styles.sectionHeader} onClick={() => setToolsOpen((o) => !o)}>
            {toolsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className={styles.sectionTitle}>{t('packBrowser.loomTools')}</span>
            <span className={styles.sectionCount}>{pack.loom_tools.length}</span>
          </div>
          {toolsOpen && (
            <div className={styles.sectionContent}>
              {pack.loom_tools.map((tool) => (
                <div key={tool.id} className={styles.loomRow}>
                  <div className={styles.loomName}>{tool.display_name || tool.tool_name}</div>
                  <span className={styles.categoryBadge}>{t('packBrowser.toolBadge')}</span>
                </div>
              ))}
              {pack.loom_tools.length === 0 && (
                <div className={styles.emptyState}>{t('packBrowser.noTools')}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Lumia editor modal */}
      {showLumiaEditor && (
        <LumiaEditorModal
          packId={pack.id}
          initialData={editingLumia || undefined}
          onSave={() => { setShowLumiaEditor(false); setEditingLumia(null); onRefresh() }}
          onClose={() => { setShowLumiaEditor(false); setEditingLumia(null) }}
        />
      )}

      {/* Loom item editor modal */}
      {showLoomEditor && (
        <LoomItemEditorModal
          packId={pack.id}
          initialData={editingLoomItem || undefined}
          onSave={() => { setShowLoomEditor(false); setEditingLoomItem(null); onRefresh() }}
          onClose={() => { setShowLoomEditor(false); setEditingLoomItem(null) }}
        />
      )}

      {/* Delete item confirmation */}
      {deleteConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={t('packBrowser.deleteItemTitle')}
          message={t('packBrowser.deleteItemMessage')}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={handleDeleteItem}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* Delete pack confirmation */}
      {deletePackConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={t('packBrowser.deletePackTitle')}
          message={t('packBrowser.deletePackMessage')}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => { setDeletePackConfirm(false); onDelete() }}
          onCancel={() => setDeletePackConfirm(false)}
        />
      )}

      {repairConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={t('packBrowser.repairGenderTitle')}
          message={t('packBrowser.repairGenderMessage')}
          variant="warning"
          confirmText={t('packBrowser.repair')}
          onConfirm={handleRepairLegacyGenderMapping}
          onCancel={() => setRepairConfirm(false)}
        />
      )}
    </div>
  )
}
