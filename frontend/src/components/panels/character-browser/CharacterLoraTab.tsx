import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Trash2 } from 'lucide-react'
import { charactersApi, type CharacterLoraBinding } from '@/api/characters'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { useStore } from '@/store'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { Button } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import styles from './CharacterEditorPage.module.css'

interface CharacterLoraTabProps {
  characterId: string
}

interface LoraOption {
  id: string
  label: string
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export default function CharacterLoraTab({ characterId }: CharacterLoraTabProps) {
  const { t } = useTranslation('panels')
  const imageGenProfiles = useStore((s) => s.imageGenProfiles)
  const activeImageGenConnectionId = useStore((s) => s.activeImageGenConnectionId)

  const activeConnection = useMemo(
    () => imageGenProfiles.find((p) => p.id === activeImageGenConnectionId) ?? null,
    [imageGenProfiles, activeImageGenConnectionId],
  )

  const supportsLoraDiscovery =
    !!activeConnection && (activeConnection.provider === 'comfyui' || activeConnection.provider === 'swarmui')

  const [loras, setLoras] = useState<LoraOption[]>([])
  const [lorasState, setLorasState] = useState<LoadState>('idle')
  const [lorasError, setLorasError] = useState<string | null>(null)

  const [binding, setBinding] = useState<CharacterLoraBinding | null>(null)
  const [loraName, setLoraName] = useState('')
  const [weightModel, setWeightModel] = useState('1')
  const [weightClip, setWeightClip] = useState('1')
  const [baseTags, setBaseTags] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const lastLoadedCharacterId = useRef<string | null>(null)

  useEffect(() => {
    if (lastLoadedCharacterId.current === characterId) return
    lastLoadedCharacterId.current = characterId

    charactersApi
      .getImageGenLora(characterId)
      .then((res) => {
        const b = res.binding
        setBinding(b)
        setLoraName(b?.lora_name ?? '')
        setWeightModel(b ? String(b.weight_model) : '1')
        setWeightClip(b ? String(b.weight_clip) : '1')
        setBaseTags(b?.base_tags ?? '')
        setSourceUrl(b?.source_url ?? '')
      })
      .catch((err) => {
        console.warn('[character-lora] Failed to load binding:', err)
      })
  }, [characterId])

  useEffect(() => {
    if (!supportsLoraDiscovery || !activeConnection) {
      setLoras([])
      setLorasState('idle')
      return
    }

    let cancelled = false
    setLorasState('loading')
    setLorasError(null)
    imageGenConnectionsApi
      .modelsBySubtype(activeConnection.id, 'loras')
      .then((res) => {
        if (cancelled) return
        setLoras(res.models.map((m) => ({ id: m.id, label: m.label })))
        setLorasState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setLorasError(err?.message || t('characterEditor.imageLora.fetchLorasFailed'))
        setLorasState('error')
      })
    return () => {
      cancelled = true
    }
  }, [supportsLoraDiscovery, activeConnection, t])

  const handleSave = useCallback(async () => {
    const trimmedName = loraName.trim()
    if (!trimmedName) {
      setStatusMessage({ kind: 'error', text: t('characterEditor.imageLora.pickBeforeSave') })
      return
    }
    const wm = Number(weightModel)
    const wc = Number(weightClip)
    if (!Number.isFinite(wm) || !Number.isFinite(wc)) {
      setStatusMessage({ kind: 'error', text: t('characterEditor.imageLora.weightsMustBeNumbers') })
      return
    }

    setSaving(true)
    setStatusMessage(null)
    try {
      const res = await charactersApi.setImageGenLora(characterId, {
        lora_name: trimmedName,
        weight_model: wm,
        weight_clip: wc,
        base_tags: baseTags.trim() || undefined,
        source_url: sourceUrl.trim() || undefined,
      })
      setBinding(res.binding)
      setStatusMessage({ kind: 'ok', text: t('characterEditor.imageLora.saved') })
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || t('characterEditor.imageLora.saveFailed') })
    } finally {
      setSaving(false)
    }
  }, [characterId, loraName, weightModel, weightClip, baseTags, sourceUrl, t])

  const handleClear = useCallback(async () => {
    setSaving(true)
    setStatusMessage(null)
    try {
      await charactersApi.deleteImageGenLora(characterId)
      setBinding(null)
      setLoraName('')
      setWeightModel('1')
      setWeightClip('1')
      setBaseTags('')
      setSourceUrl('')
      setStatusMessage({ kind: 'ok', text: t('characterEditor.imageLora.cleared') })
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || t('characterEditor.imageLora.clearFailed') })
    } finally {
      setSaving(false)
    }
  }, [characterId, t])

  const loraOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string; sublabel?: string }[] = []
    for (const lora of loras) {
      if (seen.has(lora.id)) continue
      seen.add(lora.id)
      out.push({ value: lora.id, label: lora.label, sublabel: lora.id })
    }
    if (loraName && !seen.has(loraName)) {
      out.unshift({
        value: loraName,
        label: loraName,
        sublabel: t('characterEditor.imageLora.savedValueSublabel'),
      })
    }
    return out
  }, [loras, loraName, t])

  return (
    <div className={styles.fieldGroup} style={{ gap: 16 }}>
      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>{t('characterEditor.imageLora.activeConnection')}</span>
        <span className={styles.fieldHelper}>{t('characterEditor.imageLora.activeConnectionHelper')}</span>
        <div className={styles.fieldHelper}>
          {activeConnection
            ? t('characterEditor.imageLora.connectionSummary', {
                name: activeConnection.name,
                provider: activeConnection.provider,
              })
            : t('characterEditor.imageLora.noConnectionSelected')}
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>{t('characterEditor.imageLora.lora')}</span>
        <span className={styles.fieldHelper}>{t('characterEditor.imageLora.loraHelper')}</span>
        {!supportsLoraDiscovery ? (
          <div className={styles.fieldHelper}>{t('characterEditor.imageLora.discoveryHint')}</div>
        ) : null}
        {lorasState === 'loading' ? (
          <div className={styles.fieldHelper}>{t('characterEditor.imageLora.loadingLoras')}</div>
        ) : null}
        {lorasState === 'error' ? (
          <div className={styles.fieldHelper}>
            {t('characterEditor.imageLora.loadLorasFailed', { error: lorasError })}
          </div>
        ) : null}
        <SearchableSelect
          value={loraName}
          onChange={(value) => setLoraName(value)}
          options={loraOptions}
          placeholder={t('characterEditor.imageLora.pickLora')}
          searchPlaceholder={t('characterEditor.imageLora.searchLoras')}
          emptyMessage={
            lorasState === 'ready' && loraOptions.length === 0
              ? t('characterEditor.imageLora.noLorasOnConnection')
              : t('characterEditor.imageLora.noMatchingLoras')
          }
          portal
          minWidth={320}
          clearable
        />
        <input
          type="text"
          className={styles.fieldInput}
          value={loraName}
          onChange={(e) => setLoraName(e.target.value)}
          placeholder={t('characterEditor.imageLora.manualFilenamePlaceholder')}
        />
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>{t('characterEditor.imageLora.strength')}</span>
        <span className={styles.fieldHelper}>{t('characterEditor.imageLora.strengthHelper')}</span>
        <div style={{ display: 'flex', gap: 12 }}>
          <input
            type="number"
            step="0.05"
            min={-2}
            max={2}
            className={styles.fieldInput}
            value={weightModel}
            onChange={(e) => setWeightModel(e.target.value)}
            placeholder={t('characterEditor.imageLora.modelStrengthPlaceholder')}
          />
          <input
            type="number"
            step="0.05"
            min={-2}
            max={2}
            className={styles.fieldInput}
            value={weightClip}
            onChange={(e) => setWeightClip(e.target.value)}
            placeholder={t('characterEditor.imageLora.clipStrengthPlaceholder')}
          />
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>{t('characterEditor.imageLora.baseTags')}</span>
        <span className={styles.fieldHelper}>{t('characterEditor.imageLora.baseTagsHelper')}</span>
        <textarea
          className={styles.fieldTextarea}
          rows={3}
          value={baseTags}
          onChange={(e) => setBaseTags(e.target.value)}
          placeholder={t('characterEditor.imageLora.baseTagsPlaceholder')}
        />
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>{t('characterEditor.imageLora.sourceUrl')}</span>
        <span className={styles.fieldHelper}>{t('characterEditor.imageLora.sourceUrlHelper')}</span>
        <input
          type="url"
          className={styles.fieldInput}
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder={t('characterEditor.imageLora.sourceUrlPlaceholder')}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
          {binding ? t('characterEditor.imageLora.update') : t('characterEditor.imageLora.save')}
        </Button>
        {binding ? (
          <Button variant="danger-ghost" onClick={() => setConfirmClear(true)} icon={<Trash2 size={14} />} disabled={saving}>
            {t('characterEditor.imageLora.clear')}
          </Button>
        ) : null}
        {sourceUrl ? (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--lumiverse-primary)',
              fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))',
            }}
          >
            <ExternalLink size={12} />
            {t('characterEditor.imageLora.openSourcePage')}
          </a>
        ) : null}
        {statusMessage ? (
          <span
            className={styles.fieldHelper}
            style={{
              color:
                statusMessage.kind === 'error'
                  ? 'var(--lumiverse-danger, #d44)'
                  : 'var(--lumiverse-text-dim)',
            }}
          >
            {statusMessage.text}
          </span>
        ) : null}
      </div>

      {confirmClear && (
        <ConfirmationModal
          isOpen={true}
          title={t('characterEditor.imageLora.clearConfirmTitle')}
          message={t('characterEditor.imageLora.clearConfirmMessage')}
          variant="danger"
          confirmText={t('characterEditor.imageLora.clear')}
          onConfirm={() => { setConfirmClear(false); void handleClear() }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  )
}
