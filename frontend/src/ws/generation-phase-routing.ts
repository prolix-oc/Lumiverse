interface GenerationPhaseIdentity {
  chatId: string
  generationId: string
}

interface GenerationPhaseRoutingState<Head extends GenerationPhaseIdentity> {
  activeChatId: string | null
  activeGenerationId: string | null
  streamingNavigationPaused: boolean
  chatHeads: readonly Head[]
}

export function resolveGenerationPhaseRoute<Head extends GenerationPhaseIdentity>(
  payload: GenerationPhaseIdentity,
  state: GenerationPhaseRoutingState<Head>,
) {
  return {
    activeMetadata:
      !state.streamingNavigationPaused
      && payload.chatId === state.activeChatId
      && payload.generationId === state.activeGenerationId,
    chatHead: state.chatHeads.find(
      (head) => head.chatId === payload.chatId && head.generationId === payload.generationId,
    ),
  }
}
