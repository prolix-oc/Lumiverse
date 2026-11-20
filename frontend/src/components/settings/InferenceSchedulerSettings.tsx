import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Activity, Cpu, ShieldCheck, Timer } from 'lucide-react'

import { Toggle } from '@/components/shared/Toggle'
import NumericInput from '@/components/shared/NumericInput'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import {
  inferenceSchedulerApi,
  type InferenceSchedulerConfig,
  type InferenceSchedulerOverview,
  type LocalInferenceEndpoint,
} from '@/api/inference-scheduler'
import styles from './InferenceSchedulerSettings.module.css'

const STATUS_POLL_MS = 3000

function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function sourceLabel(source: LocalInferenceEndpoint['sources'][number]): string {
  switch (source) {
    case 'chat':
      return 'Chat'
    case 'embeddings':
      return 'Embeddings'
    case 'image-generation':
      return 'Image generation'
    case 'memory-cortex':
      return 'Memory Cortex'
    case 'manual':
      return 'Manual'
    default:
      return source
  }
}

export default function InferenceSchedulerSettings() {
  const { t } = useTranslation('settings')
  const [overview, setOverview] = useState<InferenceSchedulerOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extraDraft, setExtraDraft] = useState('')
  const mounted = useRef(true)
  const polling = useRef(false)

  const load = useCallback(async (options?: { preserveError?: boolean }) => {
    try {
      const next = await inferenceSchedulerApi.getOverview()
      if (!mounted.current) return
      setOverview(next)
      if (!options?.preserveError) setError(null)
    } catch (err) {
      if (!mounted.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  const refreshStatus = useCallback(async () => {
    if (polling.current) return
    polling.current = true
    try {
      const next = await inferenceSchedulerApi.getStatus()
      if (!mounted.current) return
      setOverview((prev) => (prev ? { ...prev, status: next.status } : prev))
    } catch {
      // Status polling is best-effort; keep the last snapshot on failure.
    } finally {
      polling.current = false
    }
  }, [])

  const enabled = overview?.config.enabled ?? false
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void refreshStatus()
    }, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, refreshStatus])

  useEffect(() => {
    if (!enabled) return
    return wsClient.on(EventType.INFERENCE_SCHEDULER_STATE, () => {
      void refreshStatus()
    })
  }, [enabled, refreshStatus])

  const update = useCallback(
    async (patch: Partial<InferenceSchedulerConfig>) => {
      if (!overview) return
      setSaving(true)
      setOverview({ ...overview, config: { ...overview.config, ...patch } })
      try {
        const next = await inferenceSchedulerApi.updateConfig(patch)
        if (!mounted.current) return
        setOverview(next)
        setError(null)
      } catch (err) {
        if (!mounted.current) return
        const message = err instanceof Error ? err.message : String(err)
        // Roll the displayed values back to the server state, but keep the save
        // error visible so the control does not silently revert.
        await load({ preserveError: true })
        if (!mounted.current) return
        setError(message)
      } finally {
        if (mounted.current) setSaving(false)
      }
    },
    [overview, load],
  )

  const toggleEndpoint = useCallback(
    (endpoint: LocalInferenceEndpoint) => {
      if (!overview) return
      const { config } = overview
      if (endpoint.scheduled) {
        void update({
          excludedOrigins: [...new Set([...config.excludedOrigins, endpoint.origin])],
          extraOrigins: config.extraOrigins.filter((origin) => origin !== endpoint.origin),
        })
        return
      }
      void update({
        excludedOrigins: config.excludedOrigins.filter((origin) => origin !== endpoint.origin),
        extraOrigins: [...new Set([...config.extraOrigins, endpoint.origin])],
      })
    },
    [overview, update],
  )

  const resources = useMemo(() => overview?.status.resources ?? [], [overview])
  const endpoints = useMemo(() => overview?.endpoints ?? [], [overview])

  const removeManualOrigin = useCallback(
    (endpoint: LocalInferenceEndpoint) => {
      if (!overview) return
      void update({
        extraOrigins: overview.config.extraOrigins.filter((origin) => origin !== endpoint.origin),
        excludedOrigins: overview.config.excludedOrigins.filter((origin) => origin !== endpoint.origin),
      })
    },
    [overview, update],
  )

  const addExtraOrigins = useCallback(() => {
    if (!overview) return
    const parsed = extraDraft
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (parsed.length === 0) return
    void update({
      extraOrigins: [...new Set([...overview.config.extraOrigins, ...parsed])],
    }).then(() => setExtraDraft(''))
  }, [extraDraft, overview, update])

  if (loading) {
    return <div className={styles.loading}>{t('inferenceScheduler.loading', { defaultValue: 'Loading inference scheduler…' })}</div>
  }

  if (!overview) {
    return (
      <div className={styles.error}>
        {error ?? t('inferenceScheduler.unavailable', { defaultValue: 'Inference scheduler status is unavailable.' })}
      </div>
    )
  }

  const config = overview.config
  const activeCount = resources.reduce((sum, resource) => sum + resource.active.length, 0)
  const waitingCount = resources.reduce((sum, resource) => sum + resource.waiting.length, 0)

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.headerText}>
            <span className={styles.title}>
              <Cpu size={15} />
              {t('inferenceScheduler.title', { defaultValue: 'Local Inference Scheduling' })}
            </span>
            <span className={styles.subtitle}>
              {t('inferenceScheduler.description', {
                defaultValue:
                  'Queue requests to local models so the memory-cortex sidecar, embeddings, and image generation do not load the same VRAM at the same time.',
              })}
            </span>
          </div>
          <Toggle.Switch
            checked={config.enabled}
            onChange={(checked) => void update({ enabled: checked })}
            aria-label={t('inferenceScheduler.enable', { defaultValue: 'Enable inference scheduling' })}
            disabled={saving}
          />
        </div>

        {config.enabled && (
          <div className={styles.body}>
            <div className={styles.row}>
              <div className={styles.rowLabel}>
                {t('inferenceScheduler.unifiedPool', { defaultValue: 'One queue for all local endpoints' })}
                <span className={styles.hint}>
                  {t('inferenceScheduler.unifiedPoolHint', {
                    defaultValue:
                      'Keeps a local chat model, embedding server, and image server from running together. Turn off to give each endpoint its own queue.',
                  })}
                </span>
              </div>
              <Toggle.Switch
                size="sm"
                checked={config.unifiedLocalPool}
                onChange={(checked) => void update({ unifiedLocalPool: checked })}
                disabled={saving}
                aria-label={t('inferenceScheduler.unifiedPool', { defaultValue: 'One queue for all local endpoints' })}
              />
            </div>

            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <ShieldCheck size={14} />
                {t('inferenceScheduler.preempt', { defaultValue: 'Let chat and images interrupt background work' })}
                <span className={styles.hint}>
                  {t('inferenceScheduler.preemptHint', {
                    defaultValue:
                      'Cortex extraction and batch embedding stop when a chat response or a requested image needs the model. Interrupted batches are retried later.',
                  })}
                </span>
              </div>
              <Toggle.Switch
                size="sm"
                checked={config.preemptBackground}
                onChange={(checked) => void update({ preemptBackground: checked })}
                disabled={saving}
                aria-label={t('inferenceScheduler.preempt', { defaultValue: 'Let chat and images interrupt background work' })}
              />
            </div>

            <div className={styles.row}>
              <div className={styles.rowLabel}>
                {t('inferenceScheduler.concurrency', { defaultValue: 'Concurrent requests per queue' })}
                <span className={styles.hint}>
                  {t('inferenceScheduler.concurrencyHint', {
                    defaultValue:
                      'Keep this at 1 for a single GPU. Raise it only when the endpoint runs on CPU or has memory headroom.',
                  })}
                </span>
              </div>
              <NumericInput
                className={styles.numberInput}
                value={config.concurrency}
                integer
                min={1}
                max={8}
                onChange={(value) => {
                  if (value != null) void update({ concurrency: value })
                }}
                disabled={saving}
                aria-label={t('inferenceScheduler.concurrency', { defaultValue: 'Concurrent requests per queue' })}
              />
            </div>

            <div className={styles.row}>
              <div className={styles.rowLabel}>
                <Timer size={14} />
                {t('inferenceScheduler.maxWait', { defaultValue: 'Give up waiting after (seconds)' })}
                <span className={styles.hint}>
                  {t('inferenceScheduler.maxWaitHint', {
                    defaultValue:
                      'Chat responses never give up. Background work that waits longer than this falls back or retries. 0 waits indefinitely.',
                  })}
                </span>
              </div>
              <NumericInput
                className={styles.numberInput}
                value={config.maxWaitMs === 0 ? 0 : Math.round(config.maxWaitMs / 1000)}
                integer
                min={0}
                max={1800}
                onChange={(value) => {
                  if (value != null) void update({ maxWaitMs: value * 1000 })
                }}
                disabled={saving}
                aria-label={t('inferenceScheduler.maxWait', { defaultValue: 'Give up waiting after (seconds)' })}
              />
            </div>

            <div className={styles.endpoints}>
              <div className={styles.endpointsHeader}>
                {t('inferenceScheduler.endpoints', { defaultValue: 'Detected endpoints' })}
                <span className={styles.hint}>
                  {t('inferenceScheduler.endpointsHint', {
                    defaultValue: 'Local (loopback or LAN) endpoints are scheduled automatically. Toggle one to include or exclude it.',
                  })}
                </span>
              </div>
              {endpoints.length === 0 ? (
                <div className={styles.empty}>
                  {t('inferenceScheduler.noEndpoints', {
                    defaultValue: 'No inference endpoints are configured yet. Add a chat, embedding, or image connection first.',
                  })}
                </div>
              ) : (
                <ul className={styles.endpointList}>
                  {endpoints.map((endpoint) => (
                    <li key={endpoint.origin} className={styles.endpointRow}>
                      <div className={styles.endpointText}>
                        <span className={styles.endpointLabel}>{endpoint.label}</span>
                        <span className={styles.endpointOrigin}>{endpoint.origin}</span>
                        <span className={styles.sources}>
                          {endpoint.sources.map((source) => (
                            <span key={source} className={styles.sourceBadge}>{sourceLabel(source)}</span>
                          ))}
                        </span>
                      </div>
                      <div className={styles.endpointActions}>
                        <span
                          className={clsx(
                            styles.statusBadge,
                            endpoint.scheduled ? styles.statusScheduled : styles.statusIgnored,
                          )}
                        >
                          {endpoint.scheduled
                            ? t('inferenceScheduler.scheduled', { defaultValue: 'Scheduled' })
                            : t('inferenceScheduler.notScheduled', { defaultValue: 'Not scheduled' })}
                        </span>
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => toggleEndpoint(endpoint)}
                          disabled={saving}
                        >
                          {endpoint.scheduled
                            ? t('inferenceScheduler.exclude', { defaultValue: 'Exclude' })
                            : t('inferenceScheduler.include', { defaultValue: 'Include' })}
                        </button>
                        {endpoint.sources.includes('manual') && (
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() => removeManualOrigin(endpoint)}
                            disabled={saving}
                          >
                            {t('inferenceScheduler.remove', { defaultValue: 'Remove' })}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className={styles.inlineForm}>
                <input
                  className={styles.textInput}
                  value={extraDraft}
                  onChange={(event) => setExtraDraft(event.target.value)}
                  placeholder="http://192.168.1.50:1234/v1"
                  aria-label={t('inferenceScheduler.extraOrigins', { defaultValue: 'Extra origins to schedule' })}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={addExtraOrigins}
                  disabled={saving || extraDraft.trim().length === 0}
                >
                  {t('inferenceScheduler.addOrigin', { defaultValue: 'Add origin' })}
                </button>
              </div>
              <span className={styles.hint}>
                {t('inferenceScheduler.extraOriginsHint', {
                  defaultValue:
                    'Schedule a LAN or remote model server that is not detected automatically. Separate multiple origins with commas.',
                })}
              </span>
            </div>
          </div>
        )}
      </section>

      {config.enabled && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.headerText}>
              <span className={styles.title}>
                <Activity size={15} />
                {t('inferenceScheduler.liveStatus', { defaultValue: 'Live queue status' })}
              </span>
              <span className={styles.subtitle}>
                {activeCount === 0 && waitingCount === 0
                  ? t('inferenceScheduler.idle', { defaultValue: 'No scheduled request is running or waiting.' })
                  : t('inferenceScheduler.activitySummary', {
                      defaultValue: '{{active}} running · {{waiting}} waiting',
                      active: activeCount,
                      waiting: waitingCount,
                    })}
              </span>
            </div>
            <button type="button" className={styles.linkButton} onClick={() => void refreshStatus()}>
              {t('inferenceScheduler.refresh', { defaultValue: 'Refresh' })}
            </button>
          </div>

          <div className={styles.body}>
            {resources.length === 0 ? (
              <div className={styles.empty}>
                {t('inferenceScheduler.noActivity', {
                  defaultValue: 'Nothing has used a scheduled endpoint yet. Generate a reply or rebuild memory to see activity.',
                })}
              </div>
            ) : (
              <ul className={styles.resourceList}>
                {resources.map((resource) => (
                  <li key={resource.key} className={styles.resourceCard}>
                    <div className={styles.resourceHeader}>
                      <span className={styles.resourceName}>{resource.label}</span>
                      <span className={styles.resourceCounts}>
                        {resource.active.length}/{resource.concurrency}
                        {' · '}
                        {t('inferenceScheduler.waitingCount', {
                          defaultValue: '{{count}} waiting',
                          count: resource.waiting.length,
                        })}
                      </span>
                    </div>

                    {resource.active.length > 0 && (
                      <ul className={styles.requestList}>
                        {resource.active.map((lease) => (
                          <li key={lease.id} className={styles.requestRow}>
                            <span className={styles.requestPurpose}>{lease.purpose}</span>
                            <span className={styles.requestMeta}>
                              {t(`inferenceScheduler.class.${lease.requestClass}`, {
                                defaultValue: lease.requestClass,
                              })}
                              {' · '}
                              {formatSeconds(lease.durationMs)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {resource.waiting.length > 0 && (
                      <ul className={styles.requestList}>
                        {resource.waiting.map((request) => (
                          <li key={request.id} className={clsx(styles.requestRow, styles.requestWaiting)}>
                            <span className={styles.requestPurpose}>{request.purpose}</span>
                            <span className={styles.requestMeta}>
                              {t('inferenceScheduler.waitingFor', {
                                defaultValue: 'waiting {{duration}}',
                                duration: formatSeconds(request.waitMs),
                              })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className={styles.resourceStats}>
                      <span>
                        {t('inferenceScheduler.statsCompleted', { defaultValue: 'completed' })}: {resource.stats.completed}
                      </span>
                      <span>
                        {t('inferenceScheduler.statsPreempted', { defaultValue: 'preempted' })}: {resource.stats.preempted}
                      </span>
                      <span>
                        {t('inferenceScheduler.statsTimedOut', { defaultValue: 'gave up' })}: {resource.stats.timedOut}
                      </span>
                      {resource.stats.lastWaitMs != null && (
                        <span>
                          {t('inferenceScheduler.statsLastWait', { defaultValue: 'last wait' })}: {formatSeconds(resource.stats.lastWaitMs)}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}
