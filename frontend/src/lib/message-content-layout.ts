export const MESSAGE_CONTENT_LAYOUT_EVENT = 'lumiverse:message-content-layout'

export interface MessageContentLayoutOptions {
  /**
   * The layout change came from programmatic replacement/insertion of message
   * content. Virtualized chat lists should preserve the current viewport even
   * if their last recorded scroll direction was backward.
   */
  preserveScrollAnchor?: boolean
}

export function dispatchMessageContentLayout(
  target: Element,
  options?: MessageContentLayoutOptions,
): void {
  target.dispatchEvent(new CustomEvent(MESSAGE_CONTENT_LAYOUT_EVENT, {
    bubbles: true,
    detail: options,
  }))
}

export function shouldPreserveScrollAnchorForLayout(event: Event): boolean {
  const detail = (event as CustomEvent<unknown>).detail
  return !!detail
    && typeof detail === 'object'
    && (detail as MessageContentLayoutOptions).preserveScrollAnchor === true
}
