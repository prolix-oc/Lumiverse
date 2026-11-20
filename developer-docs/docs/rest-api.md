# REST API Reference

Lumiverse exposes two useful HTTP surfaces for developers:

- the app's core `/api/v1/settings` endpoints for persisted user preferences
- the `/api/v1/spindle/*` endpoints for managing installed extensions

## Recent chats and home visibility

`GET /api/v1/chats/recent` and `GET /api/v1/chats/recent-grouped` read the
authenticated user's saved `landingHiddenCharacterIds` setting. Hidden solo
characters and chats marked `metadata.hidden_from_recent: true` are excluded
before grouping, sorting, totals, and pagination. Group chats remain visible
when a member character is hidden from home. Character Browser, explicit chat
reads, and the hidden-chat management endpoint retain their existing behavior.

The grouped endpoint's optional `hidden_character_ids` query adds exclusions;
omitting it or sending an empty list never overrides saved hidden characters.
The same visibility policy applies to integrations that use the recent-chat
services. Recently chatted characters should use the grouped result without
`favorite_ids`, since that parameter promotes favorites ahead of recency.

## iOS character widgets

`POST /api/v1/ios-widgets/registrations` (browser session) enrolls an installation
with `{deviceId}`. It returns `{registrationId, credential, accountId, expiresAt}`.
The 90-day bearer credential can only read widget snapshots and their portraits,
or revoke its own enrollment. A repeated enrollment replaces that installation's
previous credential. `DELETE /api/v1/ios-widgets/registrations/:id` revokes an
owned enrollment; logout also clears the native shared cache and Keychain.

`GET /api/ios-widgets/v1/registrations/:id/snapshot` uses that bearer credential
and returns `{version:1, accountId, generatedAt, recent, favorites}`. Each list
contains at most 16 `{characterId, name, chatId, updatedAt}` entries. Recent is
distinct solo characters in descending latest eligible chat order, excluding
home-hidden characters, hidden/temporary/group chats, and unreadable characters
before the limit. Favorites follows the saved array order and includes
characters without a chat (`chatId:null`), including explicitly saved hidden
characters. Names contain plain text only. No messages or chat creation occur.

`GET /api/ios-widgets/v1/registrations/:id/characters/:characterId/portrait`
returns a bounded 192×256 JPEG only for a character in the current snapshot.
`DELETE /api/ios-widgets/v1/registrations/:id` revokes the credential itself.
All responses are `no-store`. Expired/revoked credentials return 401; portraits
outside the current user's widget collections return 404.

## Settings API

Use the settings endpoints when you need to inspect or update persisted host preferences.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/settings` | List all settings as `{ key, value, updated_at }[]` |
| `GET` | `/api/v1/settings/:key` | Get a single setting row |
| `PUT` | `/api/v1/settings` | Bulk upsert settings from a flat `{ key: value }` object |
| `PUT` | `/api/v1/settings/:key` | Upsert one setting from `{ value }` |
| `DELETE` | `/api/v1/settings/:key` | Delete a single setting row |

### Landing Page Display Settings

The landing page layout is controlled by persisted display settings:

| Key | Type | Description |
|---|---|---|
| `landingPageLayoutMode` | `'cards' \| 'compact'` | Switches the home screen between the existing card gallery and the compact adaptive recent-chat list. |
| `landingPageChatsDisplayed` | `number` | Controls the recent-chat batch size loaded per request. |

```bash
# Switch the landing page to the compact adaptive list view
curl -X PUT http://localhost:7860/api/v1/settings/landingPageLayoutMode \
  -H 'Content-Type: application/json' \
  -d '{ "value": "compact" }'

# Or update multiple display settings in one request
curl -X PUT http://localhost:7860/api/v1/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "landingPageLayoutMode": "compact",
    "landingPageChatsDisplayed": 24
  }'
```

## OpenRouter Endpoint Discovery

`GET /api/v1/openrouter/endpoints/:connectionId?model=openai%2Fgpt-5.4` discovers exact endpoint choices for a saved OpenRouter connection owned by the authenticated user. It uses the saved API URL and credential and returns `{ "endpoints": [{ "name": "OpenAI", "slug": "openai/flex" }] }`. Endpoint tags are fetched from OpenRouter's model endpoints API and cached for five minutes. Routing suffixes (`:floor`, `:nitro`, `:exacto`) use the base model's endpoints; catalog variants such as `:free` are preserved.

Save selections in connection `metadata.openrouter.provider_routing`: `only` restricts eligible providers, `order` specifies preference, and `ignore` excludes providers. Exact tier slugs such as `openai/flex` opt into that tier. `only` also constrains fallback routing. These settings apply to every generation using that connection, including after a model change.

## Decision Connections

All routes below are account-scoped and require authentication. Credentials are encrypted and omitted from profile responses. Profile lists use `limit` and `offset` pagination.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/decision-connections/providers` | Built-in providers and defaults |
| `GET`, `POST` | `/api/v1/decision-connections` | List or create profiles |
| `GET`, `PUT`, `DELETE` | `/api/v1/decision-connections/:id` | Read, update, or delete a profile |
| `POST` | `/api/v1/decision-connections/:id/duplicate` | Duplicate a profile and its readable credential |
| `PUT`, `DELETE` | `/api/v1/decision-connections/:id/api-key` | Set `{ api_key }` or clear the saved credential |
| `GET` | `/api/v1/decision-connections/:id/models` | Discover models with the saved credential |
| `POST` | `/api/v1/decision-connections/models/preview` | Discover with `{ provider, connection_id?, api_url?, api_key? }` |
| `POST` | `/api/v1/decision-connections/:id/test` | Check authenticated catalog access without inference |
| `POST` | `/api/v1/decision-connections/:id/sample` | Run a small decision using provider credits |
| `POST` | `/api/v1/decisions/evaluate` | Evaluate `{ connection_id?, model?, state, questions }` |

Create requires `name` and `provider` (`openrouter`, `typesafe`, or `nanogpt`). Optional fields are `api_url`, `model`, `api_key`, `is_default`, `default_parameters`, and `metadata`. An empty `api_key` on update removes the key; omission preserves it unless the provider or normalized endpoint changes. Preview only reuses a saved key for the same provider and endpoint. Setting a default atomically replaces the previous default.

Changing `provider` resets the previous URL, model, and routing defaults unless replacements are supplied in the same update.

Evaluation resolves the authenticated account, ignoring any supplied `userId`. Omitting `connection_id` selects the account's default. Validation failures return `400`, missing profiles return `404`, provider failures return `502`, and evaluation timeouts return `504`. Catalog/test/sample endpoints report provider failures in their `error` or `{ success, message }` result. Profile mutations emit `DECISION_CONNECTION_CHANGED` to the account's sessions.

See [Decision models](backend-api/decisions.md) for the question and answer contract.

## Spindle Extension Endpoints

Extensions can also be managed via the HTTP API.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/spindle` | List all installed extensions |
| `POST` | `/api/v1/spindle/install` | Install from `{ github_url }` |
| `POST` | `/api/v1/spindle/:id/update` | Pull latest + rebuild |
| `DELETE` | `/api/v1/spindle/:id` | Remove extension |
| `POST` | `/api/v1/spindle/:id/enable` | Enable + start worker |
| `POST` | `/api/v1/spindle/:id/disable` | Disable + stop worker |
| `GET` | `/api/v1/spindle/:id/permissions` | Get requested and granted permissions |
| `POST` | `/api/v1/spindle/:id/permissions` | Grant/revoke: `{ grant: [...], revoke: [...] }` |
| `GET` | `/api/v1/spindle/:id/manifest` | Get parsed `spindle.json` |
| `GET` | `/api/v1/spindle/tools` | List all registered LLM tools |
| `GET` | `/api/v1/spindle/:id/frontend` | Serve frontend JS bundle |

## Install

```bash
curl -X POST http://localhost:7860/api/v1/spindle/install \
  -H 'Content-Type: application/json' \
  -d '{ "github_url": "https://github.com/you/my-extension" }'
```

## Manage Permissions

```bash
# View permissions
curl http://localhost:7860/api/v1/spindle/my_extension/permissions

# Grant permissions
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/permissions \
  -H 'Content-Type: application/json' \
  -d '{ "grant": ["generation", "interceptor"] }'

# Revoke permissions
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/permissions \
  -H 'Content-Type: application/json' \
  -d '{ "revoke": ["cors_proxy"] }'
```

## Enable / Disable

```bash
# Enable
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/enable

# Disable
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/disable
```

## Update

```bash
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/update
```

## Remove

```bash
curl -X DELETE http://localhost:7860/api/v1/spindle/my_extension
```
