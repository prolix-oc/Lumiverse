import { useEffect, useMemo, useState } from 'react'
import { Volume2, Mic, Play, ExternalLink } from 'lucide-react'
import { useStore } from '@/store'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { ttsApi } from '@/api/tts'
import { Toggle } from '@/components/shared/Toggle'
import { speak, stop, setTTSVolume, setTTSSpeed, isSpeaking } from '@/lib/ttsAudio'
import { isWebSpeechAvailable } from '@/lib/sttEngine'
import styles from './VoiceSettings.module.css'
import clsx from 'clsx'

export default function VoiceSettings() {
  const voiceSettings = useStore((s) => s.voiceSettings)
  const setVoiceSettings = useStore((s) => s.setVoiceSettings)
  const ttsProfiles = useStore((s) => s.ttsProfiles)
  const setTtsProfiles = useStore((s) => s.setTtsProfiles)
  const setTtsProviders = useStore((s) => s.setTtsProviders)
  const addToast = useStore((s) => s.addToast)
  const openDrawer = useStore((s) => s.openDrawer)

  const [testing, setTesting] = useState(false)

  // Load TTS connections + providers on mount
  useEffect(() => {
    ttsConnectionsApi.list().then((res) => {
      setTtsProfiles(res.data || [])
    }).catch(() => {})
    ttsConnectionsApi.providers().then((res) => {
      setTtsProviders(res.providers || [])
    }).catch(() => {})
  }, [setTtsProfiles, setTtsProviders])

  const connectionOptions = useMemo(() => [
    { value: '', label: 'Select a connection...' },
    ...ttsProfiles.map((p) => ({ value: p.id, label: `${p.name} (${p.provider})` })),
  ], [ttsProfiles])

  const activeConnection = useMemo(
    () => ttsProfiles.find((p) => p.id === voiceSettings.ttsConnectionId) || null,
    [ttsProfiles, voiceSettings.ttsConnectionId]
  )

  const handleTestTTS = async () => {
    if (!voiceSettings.ttsConnectionId) {
      addToast({ type: 'warning', message: 'Select a TTS connection first' })
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
      const res = await ttsApi.synthesize(voiceSettings.ttsConnectionId, 'Hello! This is a test of the text-to-speech system.')
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || `TTS error ${res.status}`)
      }
      const buffer = await res.arrayBuffer()
      speak(buffer)
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'TTS test failed' })
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
          <span>Text-to-Speech</span>
          <div className={styles.sectionHeaderActions}>
            <button
              className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
              onClick={handleTestTTS}
              disabled={testing || !voiceSettings.ttsConnectionId}
            >
              <Play size={12} />
              {testing ? 'Speaking...' : isSpeaking() ? 'Stop' : 'Test'}
            </button>
          </div>
        </div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.ttsEnabled}
            onChange={(v) => setVoiceSettings({ ttsEnabled: v })}
            label="Enable text-to-speech"
            hint="Allow AI responses to be spoken aloud"
          />
        </div>

        <div className={clsx(styles.toggleRow, !voiceSettings.ttsEnabled && styles.toggleRowDisabled)}>
          <Toggle.Checkbox
            checked={voiceSettings.ttsAutoPlay}
            onChange={(v) => setVoiceSettings({ ttsAutoPlay: v })}
            disabled={!voiceSettings.ttsEnabled}
            label="Auto-play responses"
            hint="Automatically speak AI responses when generation completes"
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Connection</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              className={styles.select}
              value={voiceSettings.ttsConnectionId || ''}
              onChange={(e) => setVoiceSettings({ ttsConnectionId: e.target.value || null })}
            >
              {connectionOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              className={styles.actionBtn}
              onClick={() => openDrawer?.('connections')}
              title="Manage TTS connections"
            >
              <ExternalLink size={12} />
            </button>
          </div>
        </div>

        {activeConnection && (
          <div className={styles.infoBox}>
            Provider: <strong>{activeConnection.provider}</strong>
            {activeConnection.model && <> &middot; Model: <strong>{activeConnection.model}</strong></>}
            {activeConnection.voice && <> &middot; Voice: <strong>{activeConnection.voice}</strong></>}
          </div>
        )}

        <div className={styles.row}>
          <span className={styles.label}>Speed ({voiceSettings.ttsSpeed.toFixed(1)}x)</span>
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
          <span className={styles.label}>Volume ({Math.round(voiceSettings.ttsVolume * 100)}%)</span>
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

        {/* ── Speech Detection Rules ────────────────────────────────── */}
        <div className={styles.subHeader}>Speech Detection</div>

        <div className={styles.row}>
          <div>
            <span className={styles.label}>Asterisked text</span>
            <div className={styles.hint}>Content wrapped in *asterisks*</div>
          </div>
          <select
            className={styles.select}
            value={voiceSettings.speechDetectionRules.asterisked}
            onChange={(e) => updateDetectionRule('asterisked', e.target.value)}
          >
            <option value="skip">Skip (Thought)</option>
            <option value="narration">Read as Narration</option>
          </select>
        </div>

        <div className={styles.row}>
          <div>
            <span className={styles.label}>Quoted text</span>
            <div className={styles.hint}>Content wrapped in &quot;quotes&quot;</div>
          </div>
          <select
            className={styles.select}
            value={voiceSettings.speechDetectionRules.quoted}
            onChange={(e) => updateDetectionRule('quoted', e.target.value)}
          >
            <option value="speech">Read as Speech</option>
            <option value="narration">Read as Narration</option>
            <option value="skip">Skip</option>
          </select>
        </div>

        <div className={styles.row}>
          <div>
            <span className={styles.label}>Undecorated text</span>
            <div className={styles.hint}>Plain text without formatting</div>
          </div>
          <select
            className={styles.select}
            value={voiceSettings.speechDetectionRules.undecorated}
            onChange={(e) => updateDetectionRule('undecorated', e.target.value)}
          >
            <option value="narration">Read as Narration</option>
            <option value="speech">Read as Speech</option>
            <option value="skip">Skip</option>
          </select>
        </div>
      </div>

      {/* ── Speech-to-Text Section ─────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Mic size={14} />
          <span>Speech-to-Text</span>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Provider</span>
          <select
            className={styles.select}
            value={voiceSettings.sttProvider}
            onChange={(e) => setVoiceSettings({ sttProvider: e.target.value as 'webspeech' | 'openai' })}
          >
            <option value="webspeech" disabled={!isWebSpeechAvailable()}>
              Web Speech API {!isWebSpeechAvailable() ? '(Unavailable)' : ''}
            </option>
            <option value="openai">OpenAI Whisper</option>
          </select>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Language</span>
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
            label="Continuous recognition"
            hint="Keep listening after each result"
          />
        </div>

        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={voiceSettings.sttInterimResults}
            onChange={(v) => setVoiceSettings({ sttInterimResults: v })}
            label="Show interim results"
            hint="Display partial transcriptions as you speak"
          />
        </div>

        {voiceSettings.sttProvider === 'webspeech' && !isWebSpeechAvailable() && (
          <div className={styles.infoBox}>
            Web Speech API is not available in this browser. Try Chrome or Edge, or switch to the OpenAI provider.
          </div>
        )}

        {voiceSettings.sttProvider === 'openai' && (
          <div className={styles.infoBox}>
            OpenAI STT uses your OpenAI connection's API key. Configure it in Connections settings.
          </div>
        )}
      </div>
    </div>
  )
}
