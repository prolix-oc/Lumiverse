export function shouldSyncExtensionsAfterConnected<T extends { role?: string }>(
  payload: T | undefined,
): payload is T & { role: string } {
  return typeof payload?.role === 'string' && payload.role.length > 0
}
