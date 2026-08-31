import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { RotateCcw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { agentRunsApi } from '@/api/agent-runs'
import type { AgentRunStopResultV2 } from '@/types/agent-runs'
import styles from './AgentRunStopButton.module.css'

export type AgentRunStopState = 'idle' | 'stopping' | 'too_late' | 'terminal' | 'error'

export interface UseAgentRunStopOptions {
  turnId: string
  chatId?: string
  generationId?: string
  requestAuthorityId?: string
  terminal?: boolean
  onBeforeStop?: () => void
  onResult?: (result: AgentRunStopResultV2) => void
  onSettled?: () => void
}

type AgentRunStopStateEntry = {
  key: string
  state: AgentRunStopState
}

type PendingStopRequest = {
  key: string
  token: number
}

function makeStopRequestKey({
  turnId,
  chatId,
  generationId,
  requestAuthorityId,
}: Pick<UseAgentRunStopOptions, 'turnId' | 'chatId' | 'generationId' | 'requestAuthorityId'>): string {
  // Structured serialization keeps absent IDs distinct from empty IDs.
  return JSON.stringify([turnId, chatId ?? null, generationId ?? null, requestAuthorityId ?? null])
}

export function useAgentRunStop(options: UseAgentRunStopOptions) {
  const { turnId, chatId, generationId, requestAuthorityId, terminal = false, onBeforeStop, onResult, onSettled } = options
  const requestKey = makeStopRequestKey({ turnId, chatId, generationId, requestAuthorityId })
  const initialState: AgentRunStopState = 'idle'
  const requestKeyRef = useRef(requestKey)
  const requestTokenRef = useRef(0)
  const pendingRef = useRef<PendingStopRequest | null>(null)
  const [stateEntry, setStateEntry] = useState<AgentRunStopStateEntry>(() => ({
    key: requestKey,
    state: initialState,
  }))

  useLayoutEffect(() => {
    if (requestKeyRef.current !== requestKey) {
      requestKeyRef.current = requestKey
      requestTokenRef.current += 1
      pendingRef.current = null
    }
    setStateEntry(previous => previous.key === requestKey
      ? previous
      : { key: requestKey, state: initialState })
  }, [requestKey])

  useLayoutEffect(() => () => {
    requestTokenRef.current += 1
    pendingRef.current = null
  }, [])

  const state = terminal
    ? 'terminal'
    : stateEntry.key === requestKey
      ? stateEntry.state
      : initialState

  const stop = useCallback(async () => {
    if (requestKeyRef.current !== requestKey) return
    const pending = pendingRef.current
    if (
      (pending?.key === requestKey)
      || state === 'stopping'
      || state === 'too_late'
      || state === 'terminal'
    ) {
      return
    }

    const token = requestTokenRef.current + 1
    requestTokenRef.current = token
    pendingRef.current = { key: requestKey, token }
    setStateEntry({ key: requestKey, state: 'stopping' })
    onBeforeStop?.()

    const isCurrentRequest = () => (
      requestKeyRef.current === requestKey
      && requestTokenRef.current === token
    )

    try {
      const result = await agentRunsApi.stop(turnId, { chatId, generationId, requestAuthorityId })
      if (!isCurrentRequest()) return
      if (result.turnId !== turnId) {
        throw new Error('agent_run_stop_target_mismatch')
      }
      setStateEntry({ key: requestKey, state: result.status === 'accepted' ? 'stopping' : result.status })
      onResult?.(result)
    } catch {
      if (!isCurrentRequest()) return
      setStateEntry({ key: requestKey, state: 'error' })
      pendingRef.current = null
    } finally {
      if (isCurrentRequest()) {
        onSettled?.()
      }
    }
  }, [chatId, generationId, onBeforeStop, onResult, onSettled, requestAuthorityId, requestKey, state, turnId])

  return {
    state,
    stop,
    disabled: state === 'stopping' || state === 'too_late' || state === 'terminal',
  }
}

export interface AgentRunStopButtonProps extends UseAgentRunStopOptions {
  className?: string
  buttonClassName?: string
  compact?: boolean
}

export default function AgentRunStopButton({ className, buttonClassName, compact = false, ...options }: AgentRunStopButtonProps) {
  const { t } = useTranslation('chat')
  const stop = useAgentRunStop(options)
  const label = stop.state === 'idle'
    ? t('agentRuntime.stop.stop')
    : stop.state === 'stopping'
      ? t('agentRuntime.stop.stopping')
      : stop.state === 'too_late'
        ? t('agentRuntime.stop.tooLate')
        : stop.state === 'terminal'
          ? t('agentRuntime.stop.terminal')
          : t('agentRuntime.stop.retry')

  return (
    <span className={`${styles.wrapper} ${compact ? styles.compact : ''} ${className ?? ''}`}>
      <button
        type="button"
        className={`${styles.button} ${buttonClassName ?? ''}`}
        onClick={() => void stop.stop()}
        disabled={stop.disabled}
        aria-label={label}
        title={label}
        data-stop-state={stop.state}
      >
        {stop.state === 'error' ? <RotateCcw size={15} /> : <Square size={15} />}
        {!compact && <span>{label}</span>}
      </button>
    </span>
  )
}
