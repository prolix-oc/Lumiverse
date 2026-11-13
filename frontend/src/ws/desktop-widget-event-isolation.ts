/** Widget WebViews must never replay another extension's event stream. */
export function isTargetDesktopWidgetEvent(
  targetExtensionId: string,
  payload: { extensionId?: unknown } | null | undefined,
): boolean {
  return payload?.extensionId === targetExtensionId
}
