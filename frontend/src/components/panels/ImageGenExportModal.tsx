import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Toggle } from '@/components/shared/Toggle'
import { Button } from '@/components/shared/FormComponents'
import { imageGenApi } from '@/api/image-gen'
import { triggerBlobDownload } from '@/lib/downloads'
import { toast } from '@/lib/toast'
import type { ImageGenPromptPreset, ImageGenPresetKind } from '@/types/store'
import styles from './ImageGenExportModal.module.css'

const KIND_ORDER: ImageGenPresetKind[] = ['main', 'character', 'persona', 'captioning']
const KIND_LABEL_KEYS: Record<ImageGenPresetKind, string> = {
  main: 'imageGenPanel.mainPreset',
  character: 'imageGenPanel.characterPreset',
  persona: 'imageGenPanel.personaPreset',
  captioning: 'imageGenPanel.captioningPreset',
}

interface ImageGenExportModalProps {
  isOpen: boolean
  onClose: () => void
  presets: ImageGenPromptPreset[]
}

export default function ImageGenExportModal({ isOpen, onClose, presets }: ImageGenExportModalProps) {
  const { t } = useTranslation('panels')
  const [includeSettings, setIncludeSettings] = useState(true)
  const [includeParameters, setIncludeParameters] = useState(true)
  const [includeConnections, setIncludeConnections] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  // Re-arm the selection each time the modal opens so it reflects the
  // current preset list with everything selected by default.
  useEffect(() => {
    if (isOpen) setSelectedIds(new Set(presets.map((p) => p.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        kind,
        presets: presets.filter((p) => (p.kind ?? 'main') === kind),
      })).filter((g) => g.presets.length > 0),
    [presets],
  )

  const togglePreset = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleGroup = (group: ImageGenPromptPreset[], checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const preset of group) {
        if (checked) next.add(preset.id)
        else next.delete(preset.id)
      }
      return next
    })
  }

  const setAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(presets.map((p) => p.id)) : new Set())
  }

  const selectedCount = presets.filter((p) => selectedIds.has(p.id)).length
  const nothingSelected = !includeSettings && !includeParameters && !includeConnections && selectedCount === 0

  const handleExport = async () => {
    setBusy(true)
    try {
      const ids = presets.filter((p) => selectedIds.has(p.id)).map((p) => p.id)
      const data = await imageGenApi.exportConfig({
        includeSettings,
        includePresets: ids.length > 0,
        includeConnections,
        includeParameters,
        presetIds: ids.length > 0 && ids.length < presets.length ? ids : undefined,
      })
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      triggerBlobDownload(blob, 'lumiverse-image-gen-config.json')
      onClose()
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('imageGenPanel.exportFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} maxWidth={480}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('imageGenPanel.exportModalTitle')}</h2>
        <CloseButton onClick={onClose} />
      </div>

      <div className={styles.body}>
        <div className={styles.section}>
          <Toggle.Checkbox
            checked={includeSettings}
            onChange={setIncludeSettings}
            label={t('imageGenPanel.exportIncludeSettings')}
          />
          <Toggle.Checkbox
            checked={includeParameters}
            onChange={setIncludeParameters}
            label={t('imageGenPanel.exportIncludeParameters')}
            hint={t('imageGenPanel.exportIncludeParametersHint')}
          />
          <Toggle.Checkbox
            checked={includeConnections}
            onChange={setIncludeConnections}
            label={t('imageGenPanel.exportIncludeConnections')}
            hint={t('imageGenPanel.exportIncludeConnectionsHint')}
          />
        </div>

        <div className={styles.section}>
          <div className={styles.presetHeader}>
            <span className={styles.sectionTitle}>{t('imageGenPanel.exportPresets')}</span>
            {presets.length > 0 && (
              <div className={styles.bulkActions}>
                <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
                  {t('imageGenPanel.selectAll')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAll(false)}>
                  {t('imageGenPanel.selectNone')}
                </Button>
              </div>
            )}
          </div>

          {presets.length === 0 && <div className={styles.empty}>{t('imageGenPanel.noPresetsToExport')}</div>}

          {groups.map((group) => {
            const groupSelected = group.presets.filter((p) => selectedIds.has(p.id)).length
            return (
              <div key={group.kind} className={styles.group}>
                <div className={styles.groupHeader}>
                  <Toggle.Checkbox
                    checked={groupSelected === group.presets.length}
                    onChange={(checked) => toggleGroup(group.presets, checked)}
                    label={`${t(KIND_LABEL_KEYS[group.kind])} (${groupSelected}/${group.presets.length})`}
                  />
                </div>
                <div className={styles.groupList}>
                  {group.presets.map((preset) => (
                    <div key={preset.id} className={styles.presetRow}>
                      <Toggle.Checkbox
                        checked={selectedIds.has(preset.id)}
                        onChange={(checked) => togglePreset(preset.id, checked)}
                        label={preset.name}
                        className={styles.presetCheckbox}
                      />
                      {preset.mode === 'parsed_custom' && (
                        <span className={styles.modeBadge}>{t('imageGenPanel.chatAwareCustom')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className={styles.footer}>
        <span className={styles.count}>
          {t('imageGenPanel.selectedCount', { selected: selectedCount, total: presets.length })}
        </span>
        <div className={styles.footerButtons}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button variant="primary" size="sm" onClick={handleExport} disabled={busy || nothingSelected} loading={busy}>
            <Download size={14} /> {t('imageGenPanel.exportConfig')}
          </Button>
        </div>
      </div>
    </ModalShell>
  )
}
