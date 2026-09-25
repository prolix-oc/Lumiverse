# REST API Reference

Lumiverse exposes these HTTP surfaces for developers:

- the app's core `/api/v1/settings` endpoints for persisted user preferences
- the `/api/v1/decisions` and `/api/v1/decision-connections` endpoints for decision models
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

## Decision Models API

All decision endpoints require authentication. The server resolves the user from the authenticated session or bearer token. Requests cannot select another user by supplying a user ID. Decision connections are separate from chat generation connections, and their API keys are never returned by these endpoints.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/decisions/evaluate` | Evaluate a normalized `DecisionRequest`; omit `connectionId` to use the user's default |
| `GET` | `/api/v1/decision-connections/presets` | List decision providers, gateway presets, and supported protocols |
| `POST` | `/api/v1/decision-connections/models/preview` | List usable decision model IDs for a preset or custom protocol |
| `GET` | `/api/v1/decision-connections` | List the user's redacted decision connections as `{ data: [...] }` |
| `GET` | `/api/v1/decision-connections/:id` | Get one owned, redacted connection |
| `POST` | `/api/v1/decision-connections` | Create a connection |
| `PUT` | `/api/v1/decision-connections/:id` | Edit an owned connection |
| `POST` | `/api/v1/decision-connections/:id/duplicate` | Duplicate an owned connection |
| `POST` | `/api/v1/decision-connections/:id/default` | Make an owned connection the user's default |
| `POST` | `/api/v1/decision-connections/:id/test` | Send a small Noul request; return `{ success, message }` |
| `DELETE` | `/api/v1/decision-connections/:id` | Delete an owned connection |

An evaluation request has `state` and a named `questions` map. Each question has structured `instructions` and a `choice`, `score`, or `noul` criterion. The response contains answers keyed by question ID, the model ID, and optional token usage. See the [decision model reference](backend-api/decisions.md) for complete request and result shapes.

```bash
curl -X POST http://localhost:7860/api/v1/decisions/evaluate \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "state": { "message": "Payment failed during checkout" },
    "questions": {
      "urgent": {
        "type": "noul",
        "instructions": "Does this require immediate attention?"
      }
    }
  }'
```

For connection creation, supply `name` and `gateway`; add `api_key` before testing or evaluating. Presets supply the endpoint, model ID, and protocol. You can override the preset URL or model ID. A **Custom** connection also requires `protocol`, `api_url`, and `model`. Cloudflare connections require `account_id`. Editing with `api_key` omitted keeps the stored key. Connection responses expose `has_api_key`, never the key itself. Backup and import contain connection metadata but no credentials, so imported connections need a new key.

The model preview endpoint accepts `gateway` and optional `provider`, `protocol`, `api_url`, `account_id`, and `api_key`. Pass `connection_id` to preview an existing owned connection; the server may use that connection's stored key if its gateway and endpoint are unchanged. It returns `{ models: string[], model_labels: Record<string, string> }`.

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
