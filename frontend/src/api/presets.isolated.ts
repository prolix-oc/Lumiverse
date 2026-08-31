import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createDefaultAgentConfigV2 } from '@/lib/loom/agenticRuntime'
import type { AgentRuntimeHostLimits } from '@/types/agent-runtime'
import type { PortableAgenticRuntimeEnvelopeV1 } from '@/lib/loom/service'

const get = mock((..._args: unknown[]) => Promise.resolve(undefined))
const post = mock((..._args: unknown[]) => Promise.resolve(undefined))
const del = mock((..._args: unknown[]) => Promise.resolve(undefined))
const put = mock((..._args: unknown[]) => Promise.resolve(undefined))
const patch = mock((..._args: unknown[]) => Promise.resolve(undefined))
const getBlob = mock((..._args: unknown[]) => Promise.resolve(new Blob()))
const postBlob = mock((..._args: unknown[]) => Promise.resolve(new Blob()))
const upload = mock((..._args: unknown[]) => Promise.resolve(undefined))
const uploadWithProgress = mock((..._args: unknown[]) => Promise.resolve(undefined))
class ApiError extends Error {}
class RequestTimeoutError extends Error {}

mock.module('./client', () => ({
  BASE_URL: '/api/v1',
  ApiError,
  RequestTimeoutError,
  del,
  get,
  post,
  put,
  patch,
  getBlob,
  postBlob,
  upload,
  uploadWithProgress,
}))

const { presetsApi } = await import('./presets')

describe('presetsApi.getAgentRuntimeLimits', () => {
  beforeEach(() => {
    get.mockClear()
    post.mockClear()
  })

  test('fetches the authenticated effective host limits through the presets endpoint', async () => {
    const response: AgentRuntimeHostLimits = {
      childAdmissions: 1_024,
      aggregateToolCalls: 1_024,
      logicalProviderRequests: 2_048,
      physicalDispatchAttempts: 4_096,
      childOutputTokens: 1_048_576,
      workAttemptOutputTokens: 1_048_576,
      workAttemptProviderDispatches: 256,
      workAttemptUnsignedBoundaries: 256,
      workAttemptToolCalls: 1_024,
      workAttemptWorkspaceOperations: 1_024,
      workSegmentOutputTokens: 262_144,
      workSegmentProviderDispatches: 64,
      workSegmentUnsignedBoundaries: 64,
      workSegmentToolCalls: 256,
      workSegmentWorkspaceOperations: 256,
      workDispatchOutputTokens: 65_536,
      workRecoveryReserveOutputTokens: 65_536,
      workFuturePhaseReserveOutputTokens: 262_144,
      rootWallClockMs: 3_600_000,
      activityEvents: 512,
      activityBytes: 524_288,
      lifecycleLogRecords: 512,
      activeRootsPerUser: 2,
      activeRootsProcess: 16,
      providerDispatchesPerUser: 4,
      providerDispatchesProcess: 16,
      toolExecutionsPerUser: 8,
      toolExecutionsProcess: 32,
    }
    get.mockResolvedValueOnce(response)

    await expect(presetsApi.getAgentRuntimeLimits()).resolves.toBe(response)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/presets/agent-runtime-limits')
  })
  test('fetches the server-authored portable runtime envelope', async () => {
    const envelope = {
      version: 1,
      agentConfig: null,
      taskTemplates: [],
    } satisfies PortableAgenticRuntimeEnvelopeV1
    get.mockResolvedValueOnce(envelope)

    await expect(presetsApi.getPortableAgentRuntime('preset-1')).resolves.toBe(envelope)
    expect(get).toHaveBeenCalledWith('/presets/preset-1/agent-runtime/portable')
  })

  test('submits one atomic preset plus portable runtime payload', async () => {
    const envelope = {
      version: 1,
      agentConfig: null,
      taskTemplates: [],
    } satisfies PortableAgenticRuntimeEnvelopeV1
    const input = {
      preset: {
        name: 'Imported',
        provider: 'loom',
        engine: 'classic',
        regex_scripts: [{
          name: 'Portable regex',
          find_regex: 'foo',
          replace_string: 'bar',
        }],
      },
      agentRuntime: envelope,
    }
    const response = {
      preset: {
        id: 'imported-1',
        name: 'Imported',
        provider: 'loom',
        engine: 'classic',
        parameters: {},
        prompt_order: [],
        prompts: {},
        metadata: {},
        created_at: 1,
        updated_at: 1,
      },
    }
    post.mockResolvedValueOnce(response)

    await expect(presetsApi.importPortable(input)).resolves.toBe(response)
    expect(post).toHaveBeenCalledWith('/presets/import-portable', input)
  })
  test('surfaces an atomic embedded-regex import failure', async () => {
    const failure = new Error('AGENT_RUNTIME_PORTABLE_REGEX_INVALID:skipped=1')
    const input = {
      preset: { name: 'Rejected', provider: 'loom', engine: 'classic' },
      agentRuntime: {
        version: 1,
        agentConfig: null,
        taskTemplates: [],
      } satisfies PortableAgenticRuntimeEnvelopeV1,
    }
    post.mockRejectedValueOnce(failure)

    await expect(presetsApi.importPortable(input)).rejects.toBe(failure)
  })

  test('duplicates through the server endpoint instead of marshalling a local Loom preset', async () => {
    const response = {
      preset: {
        id: 'copy-1',
        name: 'Copy',
        provider: 'loom',
        engine: 'classic',
        parameters: {},
        prompt_order: [],
        prompts: {},
        metadata: {},
        created_at: 1,
        updated_at: 1,
      },
      agent_config: createDefaultAgentConfigV2(),
      agent_config_review: {
        state: 'ready' as const,
        revision: 1,
        reasonCode: null,
        unresolvedSlotIds: [],
        staleSlotIds: [],
        items: [],
      },
      copiedRegexScriptIds: ['regex-copy-1'],
    }
    post.mockResolvedValueOnce(response)

    await expect(presetsApi.duplicate('preset-1', 'Copy')).resolves.toBe(response)
    expect(post).toHaveBeenCalledWith('/presets/preset-1/duplicate', { name: 'Copy' })
  })
})
