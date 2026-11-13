import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Copy, Trash2 } from 'lucide-react'
import { requestHistoryApi, type RequestHistoryEntry, type RequestHistoryState, type RequestHistorySummary } from '@/api/request-history'
import { Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { copyTextToClipboard } from '@/lib/clipboard'
import styles from './RequestHistory.module.css'

function BodyDisplay({ label, body, message, copyLabel = 'requestHistory.copy' }: {
  label: string; body: string | null; message?: string; copyLabel?: string
}) {
  const { t } = useTranslation('settings')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const copy = async () => {
    if (body === null) return
    try {
      await copyTextToClipboard(body)
      if (!alive.current) return
      setCopyState('copied')
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      if (alive.current) setCopyState('failed')
    }
  }

  return (
    <div className={styles.payload}>
      <div className={styles.bodyHeader}>
        <span className={styles.muted}>{label}</span>
        <Button size="sm" variant="ghost" icon={copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />} disabled={body === null} onClick={copy}>
          {t(copyState === 'copied' ? 'requestHistory.copied' : copyLabel)}
        </Button>
      </div>
      {copyState === 'failed' && <p role="alert" className={styles.error}>{t('requestHistory.copyFailed')}</p>}
      {body !== null ? <pre className={styles.json}><code>{body || t('requestHistory.emptyBody')}</code></pre>
        : <p role="status" className={styles.muted}>{message}</p>}
    </div>
  )
}

function RequestRow({ row }: { row: RequestHistorySummary }) {
  const { t, i18n } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [entry, setEntry] = useState<RequestHistoryEntry | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    setEntry(null)
    setError(false)
    if (!open) return
    const controller = new AbortController()
    requestHistoryApi.get(row.id, { signal: controller.signal }).then((body) => {
      if (!controller.signal.aborted) setEntry(body)
    }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    })
    return () => controller.abort()
  }, [open, row.id, row.response.state, row.response.completedAt])

  const response = entry?.response ?? row.response
  const unavailableMessage = (reason: 'too_large' | 'unavailable' | undefined) =>
    t(reason === 'too_large' ? 'requestHistory.tooLarge' : 'requestHistory.unavailable')
  const responseMessage = response.bodyUnavailable ? unavailableMessage(response.bodyUnavailable)
    : t(response.state === 'pending' || response.state === 'receiving' ? 'requestHistory.awaitingResponse'
      : !entry ? 'requestHistory.loading' : 'requestHistory.noResponse')
  const panelId = `request-body-${row.id}`
  return (
    <li className={styles.row}>
      <button className={styles.summary} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={16} className={open ? styles.chevronOpen : styles.chevron} aria-hidden="true" />
        <span className={styles.origin}>
          <strong>{row.origin.name}</strong>
          {row.origin.operation && <span className={styles.muted}>{row.origin.operation}</span>}
        </span>
        <span className={styles.provider}>
          <span className={styles.model} title={`${row.provider} / ${row.model}`}>{row.provider} / {row.model}</span>
          <span className={row.response.state === 'failed' ? styles.error : styles.muted}>
            {row.response.status !== undefined && `HTTP ${row.response.status} · `}{t(`requestHistory.responseState.${row.response.state}`)}
          </span>
        </span>
        <time className={styles.date} dateTime={new Date(row.sentAt).toISOString()}>
          {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' }).format(row.sentAt)}
        </time>
      </button>
      {open && (
        <div className={styles.body} id={panelId}>
          {error ? (
            <p role="alert" className={styles.error}>{t('requestHistory.loadBodyFailed')}</p>
          ) : (
            <>
              <div className={styles.payloads}>
                <BodyDisplay label={t(row.redacted ? 'requestHistory.redacted' : 'requestHistory.bodyLabel')}
                  body={entry?.bodyJson ?? null} message={row.bodyUnavailable ? unavailableMessage(row.bodyUnavailable) : t('requestHistory.loading')} />
                <BodyDisplay key={response.completedAt ?? 'pending'} label={t(response.redacted ? 'requestHistory.responseRedacted' : 'requestHistory.responseLabel')}
                  body={entry?.responseBody ?? null} message={responseMessage} copyLabel="requestHistory.copyResponse" />
              </div>
              {entry?.responseError && <p className={styles.error}>{entry.responseError}</p>}
              {response.partial && entry?.responseBody != null && <p className={styles.muted}>{t('requestHistory.partialResponse')}</p>}
            </>
          )}
        </div>
      )}
    </li>
  )
}

export default function RequestHistory() {
  const { t } = useTranslation('settings')
  const [state, setState] = useState<RequestHistoryState | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  const mutating = useRef(false)
  const alive = useRef(false)

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      const version = epoch.current
      if (!mutating.current && document.visibilityState !== 'hidden') {
        try {
          const next = await requestHistoryApi.list({ signal: controller.signal })
          if (!controller.signal.aborted && version === epoch.current) {
            setState(next)
            setError(false)
          }
        } catch {
          if (!controller.signal.aborted && version === epoch.current) setError(true)
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 2000)
    }
    void refresh()
    return () => {
      alive.current = false
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  const mutate = async (action: () => Promise<RequestHistoryState>) => {
    if (mutating.current) return
    mutating.current = true
    epoch.current++
    setBusy(true)
    setError(false)
    try {
      const next = await action()
      if (alive.current) setState(next)
    } catch {
      if (alive.current) setError(true)
    } finally {
      mutating.current = false
      if (alive.current) setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby="setsec-account-requestHistory">
      <div className={styles.header}>
        <div>
          <h3 className={styles.title} id="setsec-account-requestHistory">{t('requestHistory.title')}</h3>
          <p className={styles.hint}>{t('requestHistory.hint')}</p>
        </div>
        <Toggle.Switch checked={state?.enabled ?? false} disabled={!state || busy} onChange={(enabled) => void mutate(() => requestHistoryApi.setTracking(enabled))} aria-label={t('requestHistory.enable')} />
      </div>
      {error && <p role="alert" className={styles.error}>{t('requestHistory.loadFailed')}</p>}
      {!state && !error && <p role="status" className={styles.muted}>{t('requestHistory.loading')}</p>}
      {state?.enabled && (
        <>
          <div className={styles.toolbar}>
            <span className={styles.muted}>{t('requestHistory.count', { count: state.entries.length, limit: state.limit })}</span>
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={busy || !state.entries.length} onClick={() => void mutate(requestHistoryApi.clear)}>{t('requestHistory.clear')}</Button>
          </div>
          {state.entries.length ? (
            <ul className={styles.rows} aria-label={t('requestHistory.title')}>
              {state.entries.map((row) => <RequestRow key={row.id} row={row} />)}
            </ul>
          ) : <p className={styles.empty}>{t('requestHistory.empty')}</p>}
        </>
      )}
    </section>
  )
}
