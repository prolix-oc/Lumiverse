// Linux replacement for opener's injected link handler. Keep window.open and
// ordinary in-app navigation intact; route explicit external clicks centrally.
(() => {
  window.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return;
    const anchor = event.composedPath().find(node => node instanceof Element && node.tagName === 'A');
    if (!anchor?.href || (anchor.target !== '_blank' && !event.ctrlKey && !event.shiftKey)) return;
    const url = new URL(anchor.href);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return;
    event.preventDefault();
    window.__TAURI_INTERNALS__.invoke('open_external_url', { url: url.href }).catch(() => {
      // Do not include potentially sensitive target URLs in diagnostics.
      window.alert('Could not open the external application. Check your default URL handler and try again.');
    });
  });
})();
