import { describe, expect, test } from 'bun:test'
import enPanels from '@/i18n/locales/en/panels.json'
import enSettings from '@/i18n/locales/en/settings.json'
import frPanels from '@/i18n/locales/fr/panels.json'
import frSettings from '@/i18n/locales/fr/settings.json'
import itPanels from '@/i18n/locales/it/panels.json'
import itSettings from '@/i18n/locales/it/settings.json'
import jaPanels from '@/i18n/locales/ja/panels.json'
import jaSettings from '@/i18n/locales/ja/settings.json'
import zhPanels from '@/i18n/locales/zh/panels.json'
import zhSettings from '@/i18n/locales/zh/settings.json'
import zhTWPanels from '@/i18n/locales/zh-TW/panels.json'
import zhTWSettings from '@/i18n/locales/zh-TW/settings.json'
import { AGENT_RUNTIME_LIMIT_GROUPS } from './AgentRuntimeSettingsModel'
import type { AgentRuntimeHostLimits } from '@/types/agent-runtime'

const EXPECTED_HOST_CEILING_KEYS = [
  'childAdmissions',
  'aggregateToolCalls',
  'logicalProviderRequests',
  'physicalDispatchAttempts',
  'childOutputTokens',
  'rootWallClockMs',
  'workAttemptOutputTokens',
  'workAttemptProviderDispatches',
  'workAttemptUnsignedBoundaries',
  'workAttemptToolCalls',
  'workAttemptWorkspaceOperations',
  'workSegmentOutputTokens',
  'workSegmentProviderDispatches',
  'workSegmentUnsignedBoundaries',
  'workSegmentToolCalls',
  'workSegmentWorkspaceOperations',
  'workDispatchOutputTokens',
  'workRecoveryReserveOutputTokens',
  'workFuturePhaseReserveOutputTokens',
  'activityEvents',
  'activityBytes',
  'lifecycleLogRecords',
  'activeRootsPerUser',
  'activeRootsProcess',
  'providerDispatchesPerUser',
  'providerDispatchesProcess',
  'toolExecutionsPerUser',
  'toolExecutionsProcess',
] as const satisfies ReadonlyArray<keyof AgentRuntimeHostLimits>

const locales = {
  en: { panels: enPanels, settings: enSettings },
  fr: { panels: frPanels, settings: frSettings },
  it: { panels: itPanels, settings: itSettings },
  ja: { panels: jaPanels, settings: jaSettings },
  zh: { panels: zhPanels, settings: zhSettings },
  'zh-TW': { panels: zhTWPanels, settings: zhTWSettings },
} as const

const expectedSortedKeys = [...EXPECTED_HOST_CEILING_KEYS].sort()

describe('Agent Runtime host-ceiling UI contract', () => {
  test('Settings groups expose every host ceiling exactly once', () => {
    const groupedKeys = AGENT_RUNTIME_LIMIT_GROUPS.flatMap((group) => group.keys)

    expect(groupedKeys).toEqual([...EXPECTED_HOST_CEILING_KEYS])
  })

  test('every locale labels every ceiling on the Settings and editor surfaces', () => {
    for (const [locale, resources] of Object.entries(locales)) {
      const settingsFields = resources.settings.agentRuntimeSettings.limits.fields
      const editorLabels = resources.panels.loomBuilder.agenticRuntime.workspace.ceilingLabels

      expect(Object.keys(settingsFields).sort(), `${locale} Settings ceiling labels`).toEqual(expectedSortedKeys)
      expect(Object.keys(editorLabels).sort(), `${locale} editor ceiling labels`).toEqual(expectedSortedKeys)

      for (const key of EXPECTED_HOST_CEILING_KEYS) {
        expect(settingsFields[key].trim().length, `${locale} Settings label for ${key}`).toBeGreaterThan(0)
        expect(editorLabels[key].trim().length, `${locale} editor label for ${key}`).toBeGreaterThan(0)
      }

      for (const groupKey of ['workAttempt', 'workSegment', 'workOutput'] as const) {
        expect(resources.settings.agentRuntimeSettings.limits[groupKey].trim().length, `${locale} group ${groupKey}`).toBeGreaterThan(0)
      }
    }
  })
})
