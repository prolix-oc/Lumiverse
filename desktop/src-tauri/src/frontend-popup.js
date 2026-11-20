// Installed on every top-level popup navigation, including extension callbacks
// that only know the browser window.close() API. The native command can destroy
// only the invoking frontend-popup-* window, never the main app or another view.
(() => {
  if (window.top !== window) return;
  // WKWebView can inherit user scripts from its opener's configuration. Do
  // not replace close() in the main frontend if a script is inherited back.
  const label = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (!/^frontend-popup-\d+$/.test(label || '')) return;

  // WebKit also inherits the opener's ipc:// scheme handler. Tauri's standard
  // fallback uses this view's own WKScriptMessageHandler, with its own label
  // and permissions. Block only that inherited transport; provider HTTP(S)
  // requests keep using the original fetch implementation.
  if (window.webkit?.messageHandlers?.ipc && window.fetch) {
    const browserFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = typeof input === 'string' || input instanceof URL ? input.toString() : input?.url;
      if (typeof url === 'string' && url.startsWith('ipc:')) {
        return Promise.reject(new Error('Authorization windows use per-window IPC.'));
      }
      return browserFetch(input, options);
    };
    // WKUIDelegate handles the native container. Keep the browser's close()
    // so it also marks the browsing context closed for the opener's polling.
    return;
  }

  const browserClose = window.close.bind(window);
  window.close = () => {
    try {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (invoke) {
        Promise.resolve(invoke('close_current_sso_popup')).catch(browserClose);
        return;
      }
    } catch {}
    browserClose();
  };
})();
