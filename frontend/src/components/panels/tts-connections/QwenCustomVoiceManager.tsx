import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Upload } from 'lucide-react'
import { ttsConnectionsApi } from '@/api/tts-connections'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { Button, FormField, TextArea, TextInput } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { readQwenCustomVoices } from '@/lib/qwenTts'
import { useStore } from '@/store'
import type { QwenCustomVoice, TtsConnectionProfile } from '@/types/api'
import styles from './QwenCustomVoiceManager.module.css'

interface Props {
  profile: TtsConnectionProfile
  onUpdate: (profile: TtsConnectionProfile) => void
}

function errorMessage(err: any, fallback: string) {
  return err?.body?.error || err?.message || fallback
}

function formatCreatedAt(createdAt: number) {
  if (!createdAt) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(createdAt * 1000)
}

export default function QwenCustomVoiceManager({ profile, onUpdate }: Props) {
  const { t } = useTranslation('panels')
  const addToast = useStore((s) => s.addToast)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const voices = useMemo(() => readQwenCustomVoices(profile.metadata), [profile.metadata])

  const [name, setName] = useState('')
  const [transcript, setTranscript] = useState('')
  const [xVectorOnlyMode, setXVectorOnlyMode] = useState(false)
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<QwenCustomVoice | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null)

  const canCreate = !!name.trim() && !!audioFile && (xVectorOnlyMode || !!transcript.trim())

  const resetForm = () => {
    setName('')
    setTranscript('')
    setXVectorOnlyMode(false)
    setAudioFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleCreate = async () => {
    if (!audioFile || !name.trim()) return
    setCreating(true)
    try {
      const result = await ttsConnectionsApi.createQwenCustomVoice(profile.id, {
        name: name.trim(),
        transcript: transcript.trim() || undefined,
        audio: audioFile,
        xVectorOnlyMode,
      })
      onUpdate(result.profile)
      resetForm()
      addToast({
        type: 'success',
        message: t('qwenCustomVoiceManager.createdToast', { name: result.voice.name }),
      })
    } catch (err: any) {
      addToast({
        type: 'error',
        message: errorMessage(err, t('qwenCustomVoiceManager.createFailed')),
      })
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const result = await ttsConnectionsApi.deleteQwenCustomVoice(profile.id, deleteTarget.id)
      if (result.profile) onUpdate(result.profile)
      addToast({
        type: 'success',
        message: t('qwenCustomVoiceManager.deletedToast', { name: deleteTarget.name }),
      })
      setDeleteTarget(null)
    } catch (err: any) {
      addToast({
        type: 'error',
        message: errorMessage(err, t('qwenCustomVoiceManager.deleteFailed')),
      })
    } finally {
      setDeleting(false)
    }
  }

  const handleSetDefault = async (voiceId: string) => {
    setSettingDefaultId(voiceId)
    try {
      const updated = await ttsConnectionsApi.update(profile.id, { voice: voiceId })
      onUpdate(updated)
      addToast({
        type: 'success',
        message: t('qwenCustomVoiceManager.defaultToast'),
      })
    } catch (err: any) {
      addToast({
        type: 'error',
        message: errorMessage(err, t('qwenCustomVoiceManager.defaultFailed')),
      })
    } finally {
      setSettingDefaultId(null)
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <div className={styles.title}>{t('qwenCustomVoiceManager.title')}</div>
          <div className={styles.hint}>{t('qwenCustomVoiceManager.hint')}</div>
        </div>
      </div>

      <div className={styles.createCard}>
        <FormField label={t('qwenCustomVoiceManager.voiceName')} required>
          <TextInput
            value={name}
            onChange={setName}
            placeholder={t('qwenCustomVoiceManager.voiceNamePlaceholder')}
          />
        </FormField>

        <FormField
          label={t('qwenCustomVoiceManager.transcript')}
          required={!xVectorOnlyMode}
          hint={t('qwenCustomVoiceManager.transcriptHint')}
        >
          <TextArea
            value={transcript}
            onChange={setTranscript}
            placeholder={t('qwenCustomVoiceManager.transcriptPlaceholder')}
            rows={3}
            disabled={xVectorOnlyMode}
          />
        </FormField>

        <FormField label={t('qwenCustomVoiceManager.referenceAudio')} required>
          <div className={styles.fileRow}>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload size={13} />}
              onClick={() => fileInputRef.current?.click()}
            >
              {audioFile ? t('qwenCustomVoiceManager.changeAudio') : t('qwenCustomVoiceManager.chooseAudio')}
            </Button>
            <span className={styles.fileName}>
              {audioFile?.name || t('qwenCustomVoiceManager.noAudioSelected')}
            </span>
            <input
              ref={fileInputRef}
              className={styles.hiddenInput}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
              onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
            />
          </div>
        </FormField>

        <Toggle.Checkbox
          checked={xVectorOnlyMode}
          onChange={setXVectorOnlyMode}
          label={t('qwenCustomVoiceManager.xVectorOnly')}
          hint={t('qwenCustomVoiceManager.xVectorOnlyHint')}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <Button variant="ghost" size="sm" onClick={resetForm}>
            {t('qwenCustomVoiceManager.reset')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleCreate} disabled={!canCreate} loading={creating}>
            {t('qwenCustomVoiceManager.create')}
          </Button>
        </div>
      </div>

      <div className={styles.list}>
        {voices.length === 0 ? (
          <div className={styles.empty}>{t('qwenCustomVoiceManager.empty')}</div>
        ) : (
          voices.map((voice) => (
            <div key={voice.id} className={styles.voiceCard}>
              <div className={styles.voiceInfo}>
                <div className={styles.voiceNameRow}>
                  <span className={styles.voiceName}>{voice.name}</span>
                  {profile.voice === voice.id && (
                    <span className={styles.voiceBadge}>{t('qwenCustomVoiceManager.defaultBadge')}</span>
                  )}
                </div>
                <div className={styles.voiceMeta}>
                  {t('qwenCustomVoiceManager.promptId')}: {voice.prompt_id}
                  {voice.source_filename ? ` · ${voice.source_filename}` : ''}
                  {voice.created_at ? ` · ${formatCreatedAt(voice.created_at)}` : ''}
                </div>
                {voice.transcript && (
                  <div className={styles.transcript}>{voice.transcript}</div>
                )}
              </div>

              <div className={styles.voiceActions}>
                <Button
                  variant={profile.voice === voice.id ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => handleSetDefault(voice.id)}
                  disabled={settingDefaultId === voice.id}
                  loading={settingDefaultId === voice.id}
                >
                  {profile.voice === voice.id
                    ? t('qwenCustomVoiceManager.defaultSelected')
                    : t('qwenCustomVoiceManager.makeDefault')}
                </Button>
                <Button
                  variant="danger-ghost"
                  size="icon-sm"
                  icon={<Trash2 size={13} />}
                  onClick={() => setDeleteTarget(voice)}
                  aria-label={t('qwenCustomVoiceManager.deleteAria', { name: voice.name })}
                />
              </div>
            </div>
          ))
        )}
      </div>

      {deleteTarget && (
        <ConfirmationModal
          isOpen={true}
          title={t('qwenCustomVoiceManager.deleteTitle')}
          message={t('qwenCustomVoiceManager.deleteMessage', { name: deleteTarget.name })}
          confirmText={t('qwenCustomVoiceManager.deleteConfirm')}
          variant="danger"
          loading={deleting}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
