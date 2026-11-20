# OAuth Callbacks

!!! warning "Permission required: `oauth`"

Register a callback handler to receive OAuth authorization redirects from external services (Spotify, Google, Discord, etc.). This enables extensions to implement full OAuth flows using PKCE without requiring a separate backend server.

## `spindle.oauth.getCallbackUrl()`

Returns the relative callback URL path for this extension: `/api/spindle-oauth/{identifier}/callback`

Use this to construct the `redirect_uri` for your OAuth authorization request.

```ts
const callbackUrl = spindle.oauth.getCallbackUrl()
// => "/api/spindle-oauth/my_extension/callback"
```

## `spindle.oauth.onCallback(handler)`

Register a handler invoked when the OAuth callback URL is hit. The handler receives all query parameters from the redirect. Return `{ html }` to customize the response page shown to the user, or return nothing for a default "Authorization Complete" page.

```ts
spindle.oauth.onCallback(async (params) => {
  // params contains all query parameters from the OAuth redirect
  // e.g. { code: "abc123", state: "xyz" }

  const { code, state } = params

  // Exchange the authorization code for tokens
  const tokens = await spindle.cors('https://accounts.example.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${code}&redirect_uri=...`,
  })

  await spindle.storage.setJson('tokens.json', tokens)

  return { html: '<html><body>Connected! You can close this window.</body></html>' }
})
```

## Full OAuth PKCE Example

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

let pendingVerifier: string | null = null

// Handle the callback
spindle.oauth.onCallback(async (params) => {
  if (!pendingVerifier) return { html: 'No pending authorization.' }

  const verifier = pendingVerifier
  pendingVerifier = null

  const res = await spindle.cors('https://accounts.example.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: serverBaseUrl + spindle.oauth.getCallbackUrl(),
      code_verifier: verifier,
      client_id: 'YOUR_CLIENT_ID',
    }).toString(),
  })

  await spindle.storage.setJson('tokens.json', JSON.parse(res.body))
  return { html: '<html><body><h1>Connected!</h1><script>setTimeout(()=>window.close(),2000)</script></body></html>' }
})

// Start the OAuth flow (triggered by frontend message)
spindle.onFrontendMessage(async (msg: any, userId) => {
  if (msg.type === 'connect') {
    const verifier = generateCodeVerifier()
    const challenge = await generateCodeChallenge(verifier)
    pendingVerifier = verifier

    const redirectUri = msg.serverBaseUrl + spindle.oauth.getCallbackUrl()
    const authUrl = `https://accounts.example.com/authorize?response_type=code&client_id=${msg.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`

    spindle.sendToFrontend({ type: 'auth_url', url: authUrl }, userId)
  }
})
```

!!! note
    The callback route is unauthenticated (outside `/api/v1/*`), so external OAuth servers can redirect to it without session cookies.
