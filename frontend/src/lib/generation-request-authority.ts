import { useStore } from '@/store'

/** Legacy test-facing accessors over the sole reactive store authority. */
export function beginClientGenerationAuthority(chatId: string): string {
  const authority = useStore.getState().beginGenerationRequest(chatId, {
    generationType: 'normal',
  })
  if (!authority.requestAuthorityId) {
    throw new Error('Generation request authority was not created')
  }
  return authority.requestAuthorityId
}

export function getClientGenerationAuthority(chatId: string): string | null {
  const authority = useStore.getState().generationRequests[chatId]
  return authority?.status === 'pending' || authority?.status === 'queued' || authority?.status === 'working'
    ? authority.requestAuthorityId
    : null
}

export function stopClientGenerationAuthority(chatId: string): string | null {
  return useStore.getState().stopGenerationRequest(chatId)?.requestAuthorityId ?? null
}

export function acceptsClientGenerationAuthority(
  chatId: string,
  requestAuthorityId?: string,
): boolean {
  const authority = useStore.getState().generationRequests[chatId]
  if (!authority) return !requestAuthorityId
  if (authority.status !== 'pending' && authority.status !== 'queued' && authority.status !== 'working') return false
  return authority.requestAuthorityId === null || authority.requestAuthorityId === (requestAuthorityId ?? null)
}

export function resetClientGenerationAuthoritiesForTests(): void {
  useStore.setState({ generationRequests: {} })
}
