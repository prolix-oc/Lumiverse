# Variables

Read and write local (chat-scoped) and global (cross-chat) variables. These use the same storage as the built-in `{{getvar}}`/`{{setvar}}` macros, so values set by your extension are immediately visible in prompt assembly and vice versa.

No permission is required — variables are free tier.

## Local Variables (chat-scoped)

Local variables are stored per-chat in `chat.metadata.macro_variables.local`. They correspond to the `{{getvar}}` / `{{setvar}}` macro family.

```ts
const chatId = '...' // the chat to operate on

// Set a variable
await spindle.variables.local.set(chatId, 'mood', 'happy')

// Get a variable (returns empty string if not set)
const mood = await spindle.variables.local.get(chatId, 'mood')

// Check existence
const exists = await spindle.variables.local.has(chatId, 'mood')

// List all local variables for a chat
const allVars = await spindle.variables.local.list(chatId)
// { mood: 'happy', score: '42', ... }

// Delete a variable
await spindle.variables.local.delete(chatId, 'mood')
```

## Global Variables (cross-chat)

Global variables are stored in the user's settings under the `macro_variables_global` key. They persist across all chats.

```ts
// Set a global variable
await spindle.variables.global.set('user_level', '5')

// Get a global variable
const level = await spindle.variables.global.get('user_level')

// Check existence
const exists = await spindle.variables.global.has('user_level')

// List all global variables
const allGlobals = await spindle.variables.global.list()
// { user_level: '5', theme_preference: 'dark', ... }

// Delete a global variable
await spindle.variables.global.delete('user_level')
```

## Methods

### `spindle.variables.local`

| Method | Returns | Description |
|---|---|---|
| `get(chatId, key)` | `Promise<string>` | Get a local variable value. Returns `""` if not set. |
| `set(chatId, key, value)` | `Promise<void>` | Set a local variable. |
| `delete(chatId, key)` | `Promise<void>` | Delete a local variable. |
| `list(chatId)` | `Promise<Record<string, string>>` | Get all local variables for a chat. |
| `has(chatId, key)` | `Promise<boolean>` | Check if a local variable exists. |

### `spindle.variables.global`

| Method | Returns | Description |
|---|---|---|
| `get(key)` | `Promise<string>` | Get a global variable value. Returns `""` if not set. |
| `set(key, value)` | `Promise<void>` | Set a global variable. |
| `delete(key)` | `Promise<void>` | Delete a global variable. |
| `list()` | `Promise<Record<string, string>>` | Get all global variables. |
| `has(key)` | `Promise<boolean>` | Check if a global variable exists. |

## Macro Compatibility

All values are strings, matching the macro system's behavior:

- `spindle.variables.local.set(chatId, 'score', '42')` is equivalent to `{{setvar::score::42}}` in a prompt block
- `spindle.variables.local.get(chatId, 'score')` returns the same value as `{{getvar::score}}`
- Global variables set via `spindle.variables.global` are stored in a cross-chat settings key, separate from the per-chat `{{setgvar}}` storage

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, global variable methods use the `userId` resolved from the extension context.
