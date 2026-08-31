import type { AgenticProviderLifecycle, AgenticProviderOperation } from '@/types/ws-events'

type ChatTranslate = (key: string, options?: Record<string, unknown>) => string

const OPERATION_LABEL_KEYS: Record<AgenticProviderOperation, string> = {
  council: 'agentRun.operation.council',
  root_dispatch: 'agentRun.operation.root_dispatch',
}

const LIFECYCLE_LABEL_KEYS: Record<AgenticProviderLifecycle, string> = {
  started: 'agentRun.lifecycle.started',
  waiting: 'agentRun.lifecycle.waiting',
  completed: 'agentRun.lifecycle.completed',
  error: 'agentRun.lifecycle.error',
  cancelled: 'agentRun.lifecycle.cancelled',
}

/** Formats backend progress codes without exposing protocol values in the UI. */
export function formatAgentRuntimeProgress(
  operation: unknown,
  lifecycle: unknown,
  translate: ChatTranslate,
): string | null {
  if (typeof operation !== 'string' || operation.length === 0) return null
  const operationLabelKey = Object.hasOwn(OPERATION_LABEL_KEYS, operation)
    ? OPERATION_LABEL_KEYS[operation as AgenticProviderOperation]
    : 'agentRun.operation.unknown'
  const lifecycleLabelKey = lifecycle == null
    ? 'agentRun.lifecycle.waiting'
    : typeof lifecycle === 'string' && Object.hasOwn(LIFECYCLE_LABEL_KEYS, lifecycle)
      ? LIFECYCLE_LABEL_KEYS[lifecycle as AgenticProviderLifecycle]
      : 'agentRun.lifecycle.unknown'
  return translate('agentRun.operationProgress', {
    operation: translate(operationLabelKey),
    lifecycle: translate(lifecycleLabelKey),
  })
}
