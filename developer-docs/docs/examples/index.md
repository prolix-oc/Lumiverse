# Examples

Complete working extension examples to get you started.

| Example | Type | Permissions | Description |
|---------|------|-------------|-------------|
| [Minimal Backend](minimal-backend.md) | Backend only | None | Message counter with a custom macro |
| [Prompt Interceptor](prompt-interceptor.md) | Backend only | `interceptor` | Modify generation tone via a frontend-controlled setting |
| [Frontend Only](frontend-only.md) | Frontend only | None | Live word counter badge |
| [Full Stack](full-stack.md) | Backend + Frontend | `cors_proxy`, `generation` | External API bridge with UI |
| [Character Gallery](character-gallery.md) | Backend + Frontend | `images`, `image_gen`, `chats` | Extension-owned per-character image gallery with thumbnail retrieval |
| [Frontend Process Watchdog](frontend-process-watchdog.md) | Backend + Frontend | None | Supervised frontend loop with ready/heartbeat/stop lifecycle |
| [Backend Process Watchdog](backend-process-watchdog.md) | Backend + Frontend | None | Supervised backend subprocess with ready/heartbeat/stop lifecycle |
