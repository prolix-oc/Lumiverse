import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'

/**
 * Stays on screen for as long as any extension is analysing system audio, owned by the host so an extension can
 * neither hide it nor restyle it. Stop ends that extension's session immediately.
 *
 * The user can minimise a session's pill to a small ♪ chip when it is in the way. It is never removed: something
 * listening always leaves a visible sign, and Stop is one click from the chip. Only the user's own click on this
 * component does it, and every new session starts expanded, so a different extension starting later is not hidden.
 */
export default function SystemAudioIndicator() {
  const { t } = useTranslation('shared', { keyPrefix: 'spindle.systemAudio' })
  const sessions = useStore((s) => s.systemAudioSessions)
  const [minimised, setMinimised] = useState<ReadonlySet<string>>(new Set())
  if (sessions.length === 0) return null

  const setOne = (id: string, value: boolean) =>
    setMinimised((current) => {
      // Only sessions that still exist are kept, so the set cannot grow across many sessions.
      const next = new Set([...current].filter((known) => sessions.some((session) => session.id === known)))
      if (value) next.add(id)
      else next.delete(id)
      return next
    })

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-testid="system-audio-indicator"
      style={{
        position: 'fixed',
        left: 'max(12px, env(safe-area-inset-left, 0px))',
        bottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
        zIndex: 10003,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        maxWidth: 'min(360px, calc(100vw - 24px))',
      }}
    >
      {sessions.map((session) =>
        minimised.has(session.id) ? (
          <button
            key={session.id}
            type="button"
            data-testid="system-audio-chip"
            aria-label={t('show', { name: session.extensionName })}
            title={t('show', { name: session.extensionName })}
            onClick={() => setOne(session.id, false)}
            style={{
              width: 32,
              height: 32,
              display: 'grid',
              placeItems: 'center',
              padding: 0,
              borderRadius: 999,
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 14,
              color: 'var(--lumiverse-text)',
              background: 'var(--lumiverse-bg-elevated)',
              border: '1px solid var(--lumiverse-border)',
              boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
            }}
          >
            <span aria-hidden="true">♪</span>
          </button>
        ) : (
        <div
          key={session.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 8px 8px 12px',
            borderRadius: 999,
            fontSize: 12,
            color: 'var(--lumiverse-text)',
            background: 'var(--lumiverse-bg-elevated)',
            border: '1px solid var(--lumiverse-border)',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
          }}
        >
          <span aria-hidden="true">♪</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('listening', { name: session.extensionName })}
          </span>
          <button
            type="button"
            onClick={session.stop}
            style={{
              flex: 'none',
              padding: '4px 12px',
              borderRadius: 999,
              border: 0,
              cursor: 'pointer',
              font: 'inherit',
              fontWeight: 600,
              color: 'var(--lumiverse-primary-contrast, #fff)',
              background: 'var(--lumiverse-primary)',
            }}
          >
            {t('stop')}
          </button>
          <button
            type="button"
            aria-label={t('minimise')}
            title={t('minimise')}
            onClick={() => setOne(session.id, true)}
            style={{
              flex: 'none',
              width: 24,
              height: 24,
              display: 'grid',
              placeItems: 'center',
              padding: 0,
              borderRadius: 999,
              border: 0,
              cursor: 'pointer',
              font: 'inherit',
              color: 'var(--lumiverse-text-muted, var(--lumiverse-text))',
              background: 'transparent',
            }}
          >
            <span aria-hidden="true">–</span>
          </button>
        </div>
        ),
      )}
    </div>,
    document.body,
  )
}
