import type { AgentRuntimeHostLimits } from '@/types/agent-runtime'

export const AGENT_RUNTIME_LIMIT_GROUPS: ReadonlyArray<{
  titleKey: string
  keys: ReadonlyArray<keyof AgentRuntimeHostLimits>
}> = [
  {
    titleKey: 'agentRuntimeSettings.limits.turn',
    keys: [
      'childAdmissions',
      'aggregateToolCalls',
      'logicalProviderRequests',
      'physicalDispatchAttempts',
      'childOutputTokens',
      'rootWallClockMs',
    ],
  },
  {
    titleKey: 'agentRuntimeSettings.limits.workAttempt',
    keys: [
      'workAttemptOutputTokens',
      'workAttemptProviderDispatches',
      'workAttemptUnsignedBoundaries',
      'workAttemptToolCalls',
      'workAttemptWorkspaceOperations',
    ],
  },
  {
    titleKey: 'agentRuntimeSettings.limits.workSegment',
    keys: [
      'workSegmentOutputTokens',
      'workSegmentProviderDispatches',
      'workSegmentUnsignedBoundaries',
      'workSegmentToolCalls',
      'workSegmentWorkspaceOperations',
    ],
  },
  {
    titleKey: 'agentRuntimeSettings.limits.workOutput',
    keys: [
      'workDispatchOutputTokens',
      'workRecoveryReserveOutputTokens',
      'workFuturePhaseReserveOutputTokens',
    ],
  },
  {
    titleKey: 'agentRuntimeSettings.limits.activity',
    keys: ['activityEvents', 'activityBytes', 'lifecycleLogRecords'],
  },
  {
    titleKey: 'agentRuntimeSettings.limits.capacity',
    keys: [
      'activeRootsPerUser',
      'activeRootsProcess',
      'providerDispatchesPerUser',
      'providerDispatchesProcess',
      'toolExecutionsPerUser',
      'toolExecutionsProcess',
    ],
  },
]
