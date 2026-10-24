(() => {
  // A native button invokes this function; web content receives no native bridge.
  const direction = __DIRECTION__;
  // Android can retain composer focus after dismissing its keyboard. A volume
  // press is explicit reading intent and must not be suppressed by that focus.
  const visible = el => el.getClientRects().length > 0 && el.clientHeight > 0
    && getComputedStyle(el).visibility !== 'hidden';
  const modal = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
    .some(visible);
  if (modal) return 'dialog';
  const chat = Array.from(document.querySelectorAll('[data-chat-scroll="true"]'))
    .find(visible);
  if (!chat) return 'no-chat';
  const height = Math.min(chat.clientHeight, window.visualViewport?.height ?? chat.clientHeight);
  const distance = direction * Math.max(1, height * 0.85);
  // Tell the existing chat wheel handler to cancel forced auto-follow first.
  chat.dispatchEvent(new WheelEvent('wheel', { deltaY: distance, bubbles: true }));
  chat.scrollBy({ top: distance, behavior: 'instant' });
  return 'paged';
})();
