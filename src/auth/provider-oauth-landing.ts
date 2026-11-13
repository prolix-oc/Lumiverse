interface ProviderOAuthLandingOptions {
  provider: 'openrouter' | 'nanogpt';
  code?: string;
  state?: string;
  error?: string;
  openerOrigin?: string;
}

export function renderProviderOAuthLanding(
  options: ProviderOAuthLandingOptions,
  isOriginAllowed: (origin: string) => boolean,
): string {
  // These values enter HTML attributes, never executable script text.
  const token = (value = '', limit = 512) =>
    value.length <= limit && /^[A-Za-z0-9._~+/=-]+$/.test(value) ? value : '';
  const htmlAttr = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  let openerOrigin = '';
  try {
    const parsed = new URL(options.openerOrigin || '');
    if (parsed.origin === options.openerOrigin && isOriginAllowed(parsed.origin)) {
      openerOrigin = parsed.origin;
    }
  } catch {}
  const title = options.provider === 'openrouter' ? 'OpenRouter' : 'NanoGPT';
  const background = options.provider === 'openrouter' ? '#1c1826' : '#10151e';

  return `<!DOCTYPE html>
<html><head><title>${title} Authorization</title>
<style>body{background:${background};color:rgba(255,255,255,.8);font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px}</style></head>
<body>
<div id="s" data-provider="${options.provider}" data-code="${htmlAttr(token(options.code))}" data-state="${htmlAttr(token(options.state))}" data-error="${htmlAttr(token(options.error, 128))}" data-opener-origin="${htmlAttr(openerOrigin)}">Completing authorization...</div>
<script>
var el = document.getElementById('s');
var code = el.dataset.code || '';
var state = el.dataset.state || '';
var error = el.dataset.error || '';
var targetOrigin = el.dataset.openerOrigin || window.location.origin;
var delivered = false;
if (state && (code || error)) {
  var payload = { type: el.dataset.provider + '_oauth_code', state: state };
  if (error) payload.error = error;
  else payload.code = code;
  try {
    if (window.opener) {
      window.opener.postMessage(payload, targetOrigin);
      delivered = true;
    }
  } catch {}
  // Shared browser storage survives redirects that sever window.opener.
  // It is only a fallback when the callback and the opener share an origin.
  if (targetOrigin === window.location.origin) {
    try {
      var channel = new window.BroadcastChannel('lumiverse:provider-oauth');
      channel.postMessage(payload);
      channel.close();
      delivered = true;
    } catch {}
    try {
      window.localStorage.setItem('lumiverse:provider-oauth:' + state, JSON.stringify(payload));
      delivered = true;
    } catch {}
  }
}
if (delivered) {
  el.textContent = error ? 'Authorization failed: ' + error : 'Authorized! Closing...';
  setTimeout(function() {
    var close = function() { window.close(); };
    // Rust-created popup windows need the same native close path as SSO.
    try {
      if (window.__TAURI_INTERNALS__) {
        window.__TAURI_INTERNALS__.invoke('close_current_sso_popup').catch(close);
      } else close();
    } catch { close(); }
  }, 500);
} else if (error) {
  el.textContent = 'Authorization failed: ' + error;
} else if (!code) {
  el.textContent = 'No authorization code received.';
} else if (!state) {
  el.textContent = 'No authorization state received.';
} else {
  el.textContent = 'Could not reach parent window. Copy this code: ' + code;
}
</script>
</body></html>`;
}
