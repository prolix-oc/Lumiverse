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
| [Macro Interceptor](macro-interceptor.md) | `macro_interceptor` | Transform raw templates before macro parsing/dispatch |
| [Message Content Processor](message-content-processor.md) | `chat_mutation` | Transform message content before it is written to the database |
| [LLM Tools](llm-tools.md) | `tools` | Register function-calling tools + Council-eligible tools |
| [Generation](generation.md) | `generation` | Fire LLM generations + inspect connections |
| [Image Generation](image-generation.md) | `image_gen` | Generate images via image gen connection profiles |
| [Images](images.md) | `images` | Read, upload, filter, and delete stored images |
| [Theme](theme.md) | `app_manipulation` | Apply CSS variable overrides on top of the user's theme |
| [Storage](storage.md) | Free | Scoped file storage (extension + per-user) |
| [Ephemeral Storage](ephemeral-storage.md) | `ephemeral_storage` | Temporary storage with TTL and quotas |
| [Variables](variables.md) | Free | Local (chat-scoped) and global variable access |
| [Tokens](tokens.md) | Free | Count text, message arrays, or stored chats against an explicit model or the main/sidecar model |
| [Characters](characters.md) | `characters` | CRUD on character cards |
| [Chats](chats.md) | `chats` | CRUD on chat sessions + active chat |
| [World Books](world-books.md) | `world_books` | CRUD on world books and entries |
| [Databanks](databanks.md) | `databanks` | CRUD on databanks and their documents |
| [Personas](personas.md) | `personas` | CRUD on personas + active switching + attached world books |
| [Council](council.md) | Free | Read the active council members and configuration |
| [Chat Mutation](chat-mutation.md) | `chat_mutation` | Read and modify chat messages |
| [Event Tracking](event-tracking.md) | `event_tracking` | Structured telemetry and analytics |
| [Secure Enclave](secure-enclave.md) | Free | Encrypted secret storage |
| [CORS Proxy](cors-proxy.md) | `cors_proxy` | Server-side HTTP requests |
| [OAuth](oauth.md) | `oauth` | OAuth callback handler registration |
| [Logging](logging.md) | Free | Server console logging |
| [Toast Notifications](toast.md) | Free | Show success/warning/error/info toasts in the frontend |
| [Text Editor](text-editor.md) | Free | Open the full-screen text editor modal with macro highlighting |
| [Modal](modal.md) | Free | Open a system-themed modal overlay with structured content |
| [Input Prompt](modal.md#input-prompt) | Free | Present a text input modal and await the user's response |
| [Push Notifications](push-notifications.md) | `push_notification` | Send OS-level push notifications to user devices |
| [Frontend Communication](frontend-communication.md) | Free | Message passing to/from frontend |
| [Frontend Process Lifecycle](frontend-processes.md) | Free | Spawn and supervise long-lived frontend-side controllers |
| [Backend Process Lifecycle](backend-processes.md) | Free | Spawn and supervise isolated backend subprocesses |
| [Commands](commands.md) | Free | Register custom commands in the command palette (Cmd/Ctrl+K) |
| [Version](version.md) | Free | Read the backend and frontend semantic versions |
