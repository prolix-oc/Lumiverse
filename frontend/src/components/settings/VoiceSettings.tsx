import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Volume2, Mic, Play, ExternalLink } from 'lucide-react'
import { useStore } from '@/store'
import { sttConnectionsApi } from '@/api/stt-connections'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { ttsApi } from '@/api/tts'
import { Toggle } from '@/components/shared/Toggle'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import VoicePicker from '@/components/shared/VoicePicker'
import { speak, stop, setTTSVolume, setTTSSpeed, isSpeaking } from '@/lib/ttsAudio'
import { isWebSpeechAvailable } from '@/lib/sttEngine'
import styles from './VoiceSettings.module.css'
import clsx from 'clsx'

export default function VoiceSettings() {
  const { t } = useTranslation('settings')
  const voiceSettings = useStore((s) => s.voiceSettings)
  const setVoiceSettings = useStore((s) => s.setVoiceSettings)
  const sttProfiles = useStore((s) => s.sttProfiles)
  const setSttProviders = useStore((s) => s.setSttProviders)
  const ttsProfiles = useStore((s) => s.ttsProfiles)
  const setTtsProviders = useStore((s) => s.setTtsProviders)
  const addToast = useStore((s) => s.addToast)
  const openDrawer = useStore((s) => s.openDrawer)

  const [testing, setTesting] = useState(false)

  // Connection lists come from the store; only the provider registries need a
  // refresh here.
  useEffect(() => {
    sttConnectionsApi.providers().then((res) => {
      setSttProviders(res.providers || [])
    }).catch(() => {})
    ttsConnectionsApi.providers().then((res) => {
      setTtsProviders(res.providers || [])
    }).catch(() => {})
  }, [setSttProviders, setTtsProviders])

  const activeSttConnection = useMemo(
    () => sttProfiles.find((p) => p.id === voiceSettings.sttConnectionId) || null,
    [sttProfiles, voiceSettings.sttConnectionId],
  )

  const activeConnection = useMemo(
    () => ttsProfiles.find((p) => p.id === voiceSettings.ttsConnectionId) || null,
    [ttsProfiles, voiceSettings.ttsConnectionId]
  )

  const handleTestTTS = async () => {
    if (!voiceSettings.ttsConnectionId) {
      addToast({ type: 'warning', message: t('voice.selectTtsFirst') })
      return
    }
    if (isSpeaking()) {
      stop()
      return
    }
    setTesting(true)
    try {
      setTTSVolume(voiceSettings.ttsVolume)
      setTTSSpeed(voiceSettings.ttsSpeed)
      const res = await ttsApi.synthesize(voiceSettings.ttsConnectionId, t('voice.ttsTestPhrase'))
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || `TTS error ${res.status}`)
      }
      const buffer = await res.arrayBuffer()
      speak(buffer)
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || t('voice.ttsTestFailed') })
    } finally {
      setTesting(false)
    }
  }

  const updateDetectionRule = (key: string, value: string) => {
    setVoiceSettings({
      speechDetectionRules: { ...voiceSettings.speechDetectionRules, [key]: value },
    })
  }

  return (
    <div className={styles.container}>
      {/* ── Text-to-Speech Section ──────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Volume2 size={14} />
          <span>{t('voice.ttsTitle')}</span>
          <div className={styles.sectionHeaderActions}>
            <button
              className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
              onClick={handleTestTTS}
              disabled={testing || !voiceSettings.ttsConnectionId}
            >
              <Play size={12} />
              {testing ? t('voice.speaking') : isSpeaking() ? t('voice.stop') : t('voice.test')}
            </button>
          </div>
        </div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.ttsEnabled}
            onChange={(v) => setVoiceSettings({ ttsEnabled: v })}
            label={t('voice.enableTts')}
            hint={t('voice.enableTtsHint')}
          />
        </div>

        <div className={clsx(styles.toggleRow, !voiceSettings.ttsEnabled && styles.toggleRowDisabled)}>
          <Toggle.Checkbox
            checked={voiceSettings.ttsAutoPlay}
            onChange={(v) => setVoiceSettings({ ttsAutoPlay: v })}
            disabled={!voiceSettings.ttsEnabled}
            label={t('voice.autoPlay')}
            hint={t('voice.autoPlayHint')}
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>{t('voice.connection')}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0 }}>
            <ConnectionSelect
              kind="tts"
              value={voiceSettings.ttsConnectionId || ''}
              onChange={(val) => setVoiceSettings({ ttsConnectionId: val || null })}
              placeholder={t('voice.selectConnection')}
              searchPlaceholder={t('voice.searchConnections')}
              ariaLabel={t('voice.ttsConnectionAria')}
              emptyMessage={t('voice.noTtsConnections')}
              clearable
              clearLabel={t('voice.noConnection')}
            />
            <button
              className={styles.actionBtn}
              onClick={() => openDrawer?.('connections')}
              title={t('voice.manageTts')}
            >
              <ExternalLink size={12} />
            </button>
          </div>
        </div>

        {activeConnection && (
          <div className={styles.infoBox}>
            {t('voice.provider')}: <strong>{activeConnection.provider}</strong>
            {activeConnection.model && <> &middot; {t('voice.model')}: <strong>{activeConnection.model}</strong></>}
            {activeConnection.voice && <> &middot; {t('voice.voiceLabel')}: <strong>{activeConnection.voice}</strong></>}
          </div>
        )}

        <div className={styles.row}>
          <span className={styles.label}>{t('voice.speed', { value: voiceSettings.ttsSpeed.toFixed(1) })}</span>
          <div className={styles.rangeRow}>
            <input
              type="range"
              className={styles.rangeSlider}
              min={0.5}
              max={2.0}
              step={0.1}
              value={voiceSettings.ttsSpeed}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setVoiceSettings({ ttsSpeed: v })
                setTTSSpeed(v)
              }}
            />
            <span className={styles.rangeValue}>{voiceSettings.ttsSpeed.toFixed(1)}x</span>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>{t('voice.volume', { pct: Math.round(voiceSettings.ttsVolume * 100) })}</span>
          <div className={styles.rangeRow}>
            <input
              type="range"
              className={styles.rangeSlider}
              min={0}
              max={1}
              step={0.05}
              value={voiceSettings.ttsVolume}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setVoiceSettings({ ttsVolume: v })
                setTTSVolume(v)
              }}
            />
            <span className={styles.rangeValue}>{Math.round(voiceSettings.ttsVolume * 100)}%</span>
          </div>
        </div>

        {/* ── Narration Voice ───────────────────────────────────────── */}
        <div className={styles.subHeader}>{t('voice.narration')}</div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.narrationVoice !== null}
            onChange={(v) =>
              setVoiceSettings({
                narrationVoice: v
                  ? { connectionId: voiceSettings.ttsConnectionId ?? '', voice: '' }
                  : null,
              })
            }
            disabled={!voiceSettings.ttsEnabled}
            label={t('voice.separateNarrator')}
            hint={t('voice.separateNarratorHint')}
          />
        </div>

        {voiceSettings.narrationVoice !== null && (
          <>
            <div className={styles.row} style={{ alignItems: 'flex-start' }}>
              <span className={styles.label} style={{ paddingTop: 6 }}>{t('voice.narrator')}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <VoicePicker
                  value={voiceSettings.narrationVoice}
                  onChange={(next) => setVoiceSettings({ narrationVoice: next })}
                  disabled={!voiceSettings.ttsEnabled}
                  ariaLabel={t('voice.narratorAria')}
                  clearLabel={t('voice.useSpeechForNarration')}
                  portal
                />
              </div>
            </div>

            <div className={styles.toggleRow}>
              <Toggle.Checkbox
                checked={voiceSettings.narrationVoice.parameters?.speed !== undefined}
                onChange={(v) => {
                  const current = voiceSettings.narrationVoice
                  if (!current) return
                  if (v) {
                    setVoiceSettings({
                      narrationVoice: {
                        ...current,
                        parameters: { ...current.parameters, speed: voiceSettings.ttsSpeed },
                      },
                    })
                  } else {
                    // Drop only the speed key; preserve any other future parameters.
                    const { speed: _drop, ...rest } = current.parameters ?? {}
                    setVoiceSettings({
                      narrationVoice: {
                        ...current,
                        parameters: Object.keys(rest).length > 0 ? rest : undefined,
                      },
                    })
                  }
                }}
                disabled={!voiceSettings.ttsEnabled}
                label={t('voice.separateNarratorSpeed')}
                hint={t('voice.separateNarratorSpeedHint')}
              />
            </div>

            {voiceSettings.narrationVoice.parameters?.speed !== undefined && (
              <div className={styles.row}>
                <span className={styles.label}>
                  {t('voice.narratorSpeed', { value: voiceSettings.narrationVoice.parameters.speed.toFixed(1) })}
                </span>
                <div className={styles.rangeRow}>
                  <input
                    type="range"
                    className={styles.rangeSlider}
                    min={0.5}
                    max={2.0}
                    step={0.1}
                    value={voiceSettings.narrationVoice.parameters.speed}
                    disabled={!voiceSettings.ttsEnabled}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      const current = voiceSettings.narrationVoice
                      if (!current) return
                      setVoiceSettings({
                        narrationVoice: {
                          ...current,
                          parameters: { ...current.parameters, speed: v },
                        },
                      })
                    }}
                  />
                  <span className={styles.rangeValue}>
                    {voiceSettings.narrationVoice.parameters.speed.toFixed(1)}x
                  </span>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Speech Detection Rules ────────────────────────────────── */}
        <div className={styles.subHeader}>{t('voice.speechDetection')}</div>

        <div className={styles.row}>
          <div>
            <span className={styles.label}>{t('voice.asterisked')}</span>
            <div className={styles.hint}>{t('voice.asteriskedHint')}</div>
          </div>
          <select
            className={styles.select}
            value={voiceSettings.speechDetectionRules.asterisked}
            onChange={(e) => updateDetectionRule('asterisked', e.target.value)}
          >
            <option value="skip">{t('voice.detSkip')}</option>
            <option value="narration">{t('voice.detNarration')}</option>
            <option value="thought">{t('voice.detThought')}</option>
          </select>
        </div>

        <div className={styles.row}>
          <div>
            <span className={styles.label}>{t('voice.quoted')}</span>
            <div className={styles.hint}>{t('voice.quotedHint')}</div>
          </div>
          <select
            className={styles.select}
            value={voiceSettings.speechDetectionRules.quoted}
            onChange={(e) => updateDetectionRule('quoted', e.target.value)}
          >
            <option value="speech">{t('voice.detSpeech')}</option>
            <option value="narration">{t('voice.detNarration')}</option>
            <option value="skip">{t('voice.detSkip')}</option>
          </select>
        </div>

        <div className={styles.row}>
          <div>
            <span className={styles.label}>{t('voice.undecorated')}</span>
            <div className={styles.hint}>{t('voice.undecoratedHint')}</div>
          </div>
          <select
            className={styles.select}
            value={voiceSettings.speechDetectionRules.undecorated}
            onChange={(e) => updateDetectionRule('undecorated', e.target.value)}
          >
            <option value="narration">{t('voice.detNarration')}</option>
            <option value="speech">{t('voice.detSpeech')}</option>
            <option value="skip">{t('voice.detSkip')}</option>
          </select>
        </div>
      </div>

      {/* ── Speech-to-Text Section ─────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Mic size={14} />
          <span>{t('voice.sttTitle')}</span>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>{t('voice.sttProvider')}</span>
          <select
            className={styles.select}
            value={voiceSettings.sttProvider}
            onChange={(e) => setVoiceSettings({ sttProvider: e.target.value as 'webspeech' | 'connection' })}
          >
            <option value="webspeech" disabled={!isWebSpeechAvailable()}>
              {t('voice.sttWebSpeech')} {!isWebSpeechAvailable() ? t('voice.sttUnavailable') : ''}
            </option>
            <option value="connection">{t('voice.sttConnection')}</option>
          </select>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>{t('voice.sttLanguage')}</span>
          <select
            className={styles.select}
            value={voiceSettings.sttLanguage}
            onChange={(e) => setVoiceSettings({ sttLanguage: e.target.value })}
          >
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="ja-JP">Japanese</option>
            <option value="zh-CN">Chinese (Simplified)</option>
            <option value="es-ES">Spanish</option>
            <option value="fr-FR">French</option>
            <option value="de-DE">German</option>
            <option value="it-IT">Italian</option>
            <option value="pt-BR">Portuguese (Brazil)</option>
            <option value="ko-KR">Korean</option>
            <option value="ru-RU">Russian</option>
          </select>
        </div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.sttContinuous}
            onChange={(v) => setVoiceSettings({ sttContinuous: v })}
            label={t('voice.sttContinuous')}
            hint={t('voice.sttContinuousHint')}
          />
        </div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.sttInterimResults}
            onChange={(v) => setVoiceSettings({ sttInterimResults: v })}
            label={t('voice.sttInterim')}
            hint={t('voice.sttInterimHint')}
          />
        </div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.sttAutoSubmitOnSilence}
            onChange={(v) => setVoiceSettings({ sttAutoSubmitOnSilence: v })}
            label={t('voice.sttAutoSubmit')}
            hint={voiceSettings.sttProvider === 'webspeech'
              ? t('voice.sttAutoSubmitWebHint')
              : t('voice.sttAutoSubmitConnHint')}
          />
        </div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.sttShowMicButton}
            onChange={(v) => setVoiceSettings({ sttShowMicButton: v })}
            label={t('voice.sttMicButton')}
            hint={t('voice.sttMicButtonHint')}
          />
        </div>

        {voiceSettings.sttProvider === 'webspeech' && !isWebSpeechAvailable() && (
          <div className={styles.infoBox}>
            {t('voice.sttWebSpeechUnavailable')}
          </div>
        )}

        {voiceSettings.sttProvider === 'connection' && (
          <>
            <div className={styles.row}>
              <span className={styles.label}>{t('voice.connection')}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0 }}>
                <ConnectionSelect
                  kind="stt"
                  value={voiceSettings.sttConnectionId || ''}
                  onChange={(val) => setVoiceSettings({ sttConnectionId: val || null })}
                  placeholder={t('voice.selectConnection')}
                  searchPlaceholder={t('voice.searchConnections')}
                  ariaLabel={t('voice.sttConnectionAria')}
                  emptyMessage={t('voice.noSttConnections')}
                  clearable
                  clearLabel={t('voice.noConnection')}
                />
                <button
                  className={styles.actionBtn}
                  onClick={() => openDrawer?.('connections')}
                  title={t('voice.manageStt')}
                >
                  <ExternalLink size={12} />
                </button>
              </div>
            </div>

            <div className={styles.infoBox}>
              {activeSttConnection
                ? <>{t('voice.provider')}: <strong>{activeSttConnection.provider}</strong>{activeSttConnection.model && <> &middot; {t('voice.model')}: <strong>{activeSttConnection.model}</strong></>}</>
                : t('voice.sttConnectionFallback')}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
