# REST API Reference

Lumiverse exposes two useful HTTP surfaces for developers:

- the app's core `/api/v1/settings` endpoints for persisted user preferences
- the `/api/v1/spindle/*` endpoints for managing installed extensions

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

Create requires `name` and `provider` (`openrouter` or `typesafe`). Optional fields are `api_url`, `model`, `api_key`, `is_default`, `default_parameters`, and `metadata`. An empty `api_key` on update removes the key; omission preserves it unless the provider or normalized endpoint changes. Preview only reuses a saved key for the same provider and endpoint. Setting a default atomically replaces the previous default.

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
