import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button, FormField, Select } from '@/components/shared/FormComponents'
import SearchableSelect from '@/components/shared/SearchableSelect'
import SearchField from '@/components/shared/SearchField'
import Pagination from '@/components/shared/Pagination'
import MessageAudioPlayer from '@/components/chat/MessageAudioPlayer'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { getTtsVoiceLabel } from '@/lib/ttsVoiceLabels'
import type { TtsConnectionVoicesPreviewInput, TtsLibraryVoice, TtsVoiceLibraryOptions, TtsVoiceLibraryResult } from '@/types/api'
import presentation from '@/components/shared/ModalPresentation.module.css'
import cards from '@/components/panels/tts-connections/QwenCustomVoiceManager.module.css'
import styles from './VoiceLibraryModal.module.css'

interface Props {
  connection: TtsConnectionVoicesPreviewInput
  value?: string
  onSelect: (voice: TtsLibraryVoice) => void
  onClose: () => void
}

const PAGE_SIZE = 20

/** A library browser composed from the existing modal, form, voice-card and audio controls. */
export default function VoiceLibraryModal({ connection, value, onSelect, onClose }: Props) {
  const { t, i18n } = useTranslation('shared', { keyPrefix: 'voiceLibrary' })
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState<TtsVoiceLibraryOptions>({ page: 0, sort: 'trending' })
  const [result, setResult] = useState<TtsVoiceLibraryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [preview, setPreview] = useState<TtsLibraryVoice | null>(null)
  const languageOptions = useMemo(() => {
    const names = new Intl.DisplayNames([i18n?.language || 'en'], { type: 'language' })
    const options: Array<{ value: string; label: string }> = []
    // Offer named languages without limiting discovery to those on the current page.
    for (let first = 97; first <= 122; first++) {
      for (let second = 97; second <= 122; second++) {
        const code = String.fromCharCode(first, second)
        const label = names.of(code)
        if (label && label !== code && Intl.getCanonicalLocales(code)[0] === code) options.push({ value: code, label })
      }
    }
    return [{ value: '', label: t('allLanguages') }, ...options.sort((a, b) => a.label.localeCompare(b.label, i18n?.language))]
  }, [i18n?.language, t])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setError('')
    setResult(null)
    setPreview(null)
    const timer = setTimeout(async () => {
      try {
        const response = await ttsConnectionsApi.voiceLibrary(
          { ...connection, ...query, search: query.search?.trim() || undefined, language: query.language?.trim() || undefined, page_size: PAGE_SIZE },
          { signal: controller.signal },
        )
        if (cancelled) return
        if (response.error) throw new Error(response.error)
        setResult(response)
      } catch (err: any) {
        if (!cancelled) setError(err?.body?.error || err?.message || t('loadFailed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [connection, query, retry, t])

  const updateFilter = (filter: Partial<TtsVoiceLibraryOptions>) => {
    setResult(null)
    setQuery((previous) => ({ ...previous, ...filter, page: 0 }))
  }
  const page = query.page ?? 0
  // The provider's count is a snapshot. has_more determines whether another page exists.
  const totalPages = result?.has_more ? Math.max(page + 2, Math.ceil((result.total_count || 0) / PAGE_SIZE)) : page + 1

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={820} maxHeight="88dvh" modalId="voice-library" data-component="VoiceLibraryModal">
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={presentation.header}>
          <div className={presentation.headerText}>
            <h3 id={titleId} className={presentation.title}>{t('title')}</h3>
            <p className={presentation.subtitle}>{t('hint')}</p>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div className={presentation.body}>
          <SearchField value={query.search || ''} onChange={(search) => updateFilter({ search })} placeholder={t('search')} clearLabel={t('clearSearch')} />
          <div className={styles.filters}>
            <FormField label={t('language')}>
              <SearchableSelect value={query.language || ''} onChange={(language) => updateFilter({ language })} options={languageOptions} ariaLabel={t('language')} searchPlaceholder={t('searchLanguages')} portal />
            </FormField>
            <FormField label={t('gender')}>
              <Select value={query.gender || ''} onChange={(gender) => updateFilter({ gender: (gender || undefined) as TtsVoiceLibraryOptions['gender'] })} aria-label={t('gender')} options={[
                { value: '', label: t('allGenders') },
                { value: 'female', label: t('female') },
                { value: 'male', label: t('male') },
                { value: 'neutral', label: t('neutral') },
              ]} />
            </FormField>
            <FormField label={t('sort')}>
              <Select value={query.sort || 'trending'} onChange={(sort) => updateFilter({ sort: sort as TtsVoiceLibraryOptions['sort'] })} aria-label={t('sort')} options={[
                { value: 'trending', label: t('trending') },
                { value: 'created_date', label: t('latest') },
                { value: 'cloned_by_count', label: t('mostUsers') },
                { value: 'usage_character_count_1y', label: t('mostUsed') },
              ]} />
            </FormField>
          </div>
          {error && <FormField label="" error={error}><Button size="sm" onClick={() => setRetry((previous) => previous + 1)}>{t('retry')}</Button></FormField>}
          <div className={cards.list} aria-busy={loading}>
            {loading && <div className={cards.empty} role="status">{t('loading')}</div>}
            {!loading && !error && result?.voices.length === 0 && <div className={cards.empty} role="status">{t('empty')}</div>}
            {result?.voices.map((voice) => (
              <article key={voice.id} className={`${cards.voiceCard} ${styles.card}`}>
                <div className={cards.voiceInfo}>
                  <div className={cards.voiceNameRow}>
                    <span className={cards.voiceName}>{getTtsVoiceLabel(voice)}</span>
                    {value === voice.id && <span className={cards.voiceBadge}>{t('selected')}</span>}
                    {voice.rate != null && voice.rate !== 1 && <span className={cards.voiceBadge}>{t('creditMultiplier', { rate: voice.rate })}</span>}
                    {voice.liveModeration && <span className={cards.voiceBadge}>{t('liveModeration')}</span>}
                  </div>
                  <div className={cards.voiceMeta}>{[voice.language, voice.accent, voice.age, voice.useCase?.replaceAll('_', ' ')].filter(Boolean).join(' · ')}</div>
                  {voice.description && <div className={cards.transcript}>{voice.description}</div>}
                  {voice.noticePeriod != null && voice.noticePeriod > 0 && <div className={cards.voiceMeta}>{t('noticePeriod', { count: voice.noticePeriod })}</div>}
                </div>
                <div className={cards.voiceActions}>
                  {voice.previewUrl && <Button size="sm" variant="ghost" icon={<Play size={13} />} aria-label={t('previewAria', { name: voice.name })} onClick={() => setPreview(voice)}>{t('preview')}</Button>}
                  <Button size="sm" variant="primary" onClick={() => { onSelect(voice); onClose() }} aria-label={t('useVoiceAria', { name: voice.name })}>{t('useVoice')}</Button>
                </div>
              </article>
            ))}
          </div>
        </div>
        <div className={`${presentation.footer} ${styles.footer}`}>
          {preview?.previewUrl && <div className={styles.preview}>
            <span className={cards.voiceName}>{preview.name}</span>
            <MessageAudioPlayer key={preview.id} src={preview.previewUrl} title={preview.name} autoPlay />
          </div>}
          {result && <Pagination currentPage={page + 1} totalPages={totalPages} totalItems={result.total_count || undefined} onPageChange={(next) => { setResult(null); setQuery((previous) => ({ ...previous, page: next - 1 })) }} />}
          <Button size="sm" variant="ghost" onClick={onClose}>{t('close')}</Button>
        </div>
      </div>
    </ModalShell>
  )
}
