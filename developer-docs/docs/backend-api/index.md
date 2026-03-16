# Backend API

Your backend module runs in an isolated Bun worker thread. The `spindle` global is automatically available — no imports needed.

For TypeScript support, add this at the top of your backend file:

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI
```

## API Surface

| Category | Permission | Description |
|----------|-----------|-------------|
| [Events](events.md) | Free | Subscribe to Lumiverse lifecycle events |
| [Macros](macros.md) | Free | Register custom `{{macros}}` for prompts |
| [Interceptors](interceptors.md) | `interceptor` | Modify the prompt before it reaches the LLM |
| [Context Handlers](context-handlers.md) | `context_handler` | Enrich the generation context before assembly |
| [LLM Tools](llm-tools.md) | `tools` | Register function-calling tools |
| [Generation](generation.md) | `generation` | Fire LLM generations + inspect connections |
| [Storage](storage.md) | Free | Scoped file storage (extension + per-user) |
| [Ephemeral Storage](ephemeral-storage.md) | `ephemeral_storage` | Temporary storage with TTL and quotas |
| [Variables](variables.md) | Free | Local (chat-scoped) and global variable access |
| [Characters](characters.md) | `characters` | CRUD on character cards |
| [Chats](chats.md) | `chats` | CRUD on chat sessions + active chat |
| [Chat Mutation](chat-mutation.md) | `chat_mutation` | Read and modify chat messages |
| [Event Tracking](event-tracking.md) | `event_tracking` | Structured telemetry and analytics |
| [Secure Enclave](secure-enclave.md) | Free | Encrypted secret storage |
| [CORS Proxy](cors-proxy.md) | `cors_proxy` | Server-side HTTP requests |
| [OAuth](oauth.md) | `oauth` | OAuth callback handler registration |
| [Logging](logging.md) | Free | Server console logging |
| [Frontend Communication](frontend-communication.md) | Free | Message passing to/from frontend |
