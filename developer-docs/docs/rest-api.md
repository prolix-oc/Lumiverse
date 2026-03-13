# REST API Reference

Extensions can also be managed via the HTTP API.

## Endpoints

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
