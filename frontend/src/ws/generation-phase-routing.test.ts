import { describe, expect, test } from 'bun:test'
import { resolveGenerationPhaseRoute } from './generation-phase-routing'

interface TestHead {
  chatId: string
  generationId: string
  label: string
}

const activeChatId = 'active-chat'
const activeGenerationId = 'active-generation'

function state(
  chatHeads: TestHead[],
  overrides: Partial<{
    activeChatId: string | null
    activeGenerationId: string | null
    streamingNavigationPaused: boolean
  }> = {},
) {
  return {
    activeChatId,
    activeGenerationId,
    streamingNavigationPaused: false,
    chatHeads,
    ...overrides,
  }
}

describe('GENERATION_PHASE_CHANGED routing', () => {
  test('routes a background chat only to the head matching both identities', () => {
    const sameGenerationOtherChat = {
      chatId: 'other-chat',
      generationId: 'background-generation',
      label: 'wrong chat',
    }
    const sameChatOtherGeneration = {
      chatId: 'background-chat',
      generationId: 'other-generation',
      label: 'wrong generation',
    }
    const backgroundHead = {
      chatId: 'background-chat',
      generationId: 'background-generation',
      label: 'exact head',
    }

    const route = resolveGenerationPhaseRoute(
      { chatId: 'background-chat', generationId: 'background-generation' },
      state([sameGenerationOtherChat, sameChatOtherGeneration, backgroundHead]),
    )

    expect(route.activeMetadata).toBe(false)
    expect(route.chatHead).toBe(backgroundHead)
  })

  test('rejects a stale generation from the active chat', () => {
    const currentHead = {
      chatId: activeChatId,
      generationId: activeGenerationId,
      label: 'current generation',
    }
    const sameGenerationOtherChat = {
      chatId: 'other-chat',
      generationId: 'stale-generation',
      label: 'wrong chat',
    }

    const route = resolveGenerationPhaseRoute(
      { chatId: activeChatId, generationId: 'stale-generation' },
      state([currentHead, sameGenerationOtherChat]),
    )

    expect(route.activeMetadata).toBe(false)
    expect(route.chatHead).toBeUndefined()
  })

  test('routes an exact active identity to global metadata and its head', () => {
    const activeHead = {
      chatId: activeChatId,
      generationId: activeGenerationId,
      label: 'active generation',
    }

    const route = resolveGenerationPhaseRoute(
      { chatId: activeChatId, generationId: activeGenerationId },
      state([activeHead]),
    )

    expect(route.activeMetadata).toBe(true)
    expect(route.chatHead).toBe(activeHead)
  })

  test('freezes global metadata while navigation is paused but keeps the head routed', () => {
    const activeHead = {
      chatId: activeChatId,
      generationId: activeGenerationId,
      label: 'paused generation',
    }

    const route = resolveGenerationPhaseRoute(
      { chatId: activeChatId, generationId: activeGenerationId },
      state([activeHead], { streamingNavigationPaused: true }),
    )

    expect(route.activeMetadata).toBe(false)
    expect(route.chatHead).toBe(activeHead)
  })
})
