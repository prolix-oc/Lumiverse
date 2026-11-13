# Lumiverse for Stream Deck

The plugin provides three user-facing actions:

- **Open Recent Chat** opens the user's most recently updated Lumiverse chat.
- **Open Character Chat** opens the most recent chat for a character selected in the Property Inspector.
- **Browse Lumiverse** opens a paginated device profile containing characters and recent chats. Use the toggle,
  previous, next, and back keys to navigate; selecting a result opens its chat.

The browser profile is bundled for Stream Deck, Mini, XL, and Stream Deck +. Stream Deck installs the matching
profile the first time **Browse Lumiverse** is used.

## Build and validate

```powershell
cd stream-deck
bun install
bun run build
bun run validate
```

The installable plugin directory is `com.lumiverse.streamdeck.sdPlugin`.

## Create an integration token

While signed in to Lumiverse, run this in the browser developer console:

```js
fetch('/api/v1/stream-deck/tokens', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'My Stream Deck' }),
}).then(r => r.json()).then(console.log)
```

Copy the returned `token` immediately; Lumiverse stores only its SHA-256 hash and cannot show it again. Paste the token and the Lumiverse server URL into an action's Property Inspector. Tokens can be listed or revoked through `GET /api/v1/stream-deck/tokens` and `DELETE /api/v1/stream-deck/tokens/:id`.

The token is accepted only under `/api/integrations/stream-deck/v1`. It cannot authenticate against the general Lumiverse API.
