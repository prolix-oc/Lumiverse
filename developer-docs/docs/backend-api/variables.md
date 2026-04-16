# Variables

Read and write **local**, **global**, and **chat** variables. All three namespaces share storage with the built-in macro engine, so values set by your extension are immediately visible in prompt assembly and vice versa.

No permission is required — variables are free tier.

| Namespace | Macro family | Storage | Persists? |
|---|---|---|---|
| `local` | `{{getvar}}` / `{{setvar}}` (no prefix) | `chat.metadata.macro_variables.local` | Per-chat scratchpad. Persisted via the spindle API; cleared by in-prompt mutations. |
| `chat` | `{{getchatvar}}` / `{{setchatvar}}` (`@` prefix) | `chat.metadata.chat_variables` | **Persisted across generations within the same chat.** Use this for state you want to survive turns (HP, counters, flags). |
| `global` | `{{getgvar}}` / `{{setgvar}}` (`$` prefix) | `macro_variables_global` setting | Persisted user-wide, across all chats. |

!!! tip "Which one should I use?"
    Reach for `chat` whenever you want game-state-style values — turn counters, hit points, flags — that should survive across regens, swipes, and message edits. `local` is best understood as a per-evaluation scratchpad that the spindle API can also write to. `global` is for cross-chat user preferences.

## Local Variables (per-chat scratchpad)

Local variables are stored per-chat in `chat.metadata.macro_variables.local`. They correspond to the unprefixed `{{getvar}}` / `{{setvar}}` macro family. Mutations made through this API are persisted to the chat record, but in-prompt macro mutations (`{{setvar::x::5}}` inside a prompt block) are evaluation-scoped only.

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

## Chat Variables (persisted per-chat)

Chat variables live in `chat.metadata.chat_variables` and **persist across generations within the same chat**. They correspond to the `@`-prefixed macro family — `{{@hp}}`, `{{@turn++}}`, `{{setchatvar::flag::true}}`, `{{getchatvar::flag}}`, `{{incchatvar::turn}}`, etc. When a generation runs and the assembled prompt mutates a chat variable, the new value is flushed back to chat metadata after assembly so subsequent turns see it.

This is the right namespace for game-loop state: HP, turn counters, inventory flags, story milestones — anything you want to survive regens, swipes, and message edits.

```ts
const chatId = '...'

// Initialize state for a new chat
await spindle.variables.chat.set(chatId, 'hp', '100')
await spindle.variables.chat.set(chatId, 'turn', '0')

// Read current state (returns "" if unset)
const hp = await spindle.variables.chat.get(chatId, 'hp')

// Check existence
const hasInventory = await spindle.variables.chat.has(chatId, 'inventory')

// Snapshot all chat variables
const state = await spindle.variables.chat.list(chatId)
// { hp: '100', turn: '7', flag_met_villain: 'true' }

// Clear a single key
await spindle.variables.chat.delete(chatId, 'temporary_buff')
```

These values are visible to prompt assembly via `{{@key}}` / `{{getchatvar::key}}`, so you can write a single variable from your extension and have it appear inside character cards, world books, or system prompts on the very next turn.

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

### `spindle.variables.chat`

| Method | Returns | Description |
|---|---|---|
| `get(chatId, key)` | `Promise<string>` | Get a chat-persisted variable. Returns `""` if not set. |
| `set(chatId, key, value)` | `Promise<void>` | Set a chat-persisted variable. |
| `delete(chatId, key)` | `Promise<void>` | Delete a chat-persisted variable. |
| `list(chatId)` | `Promise<Record<string, string>>` | Get all chat-persisted variables for a chat. |
| `has(chatId, key)` | `Promise<boolean>` | Check if a chat-persisted variable exists. |

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

- `spindle.variables.local.set(chatId, 'score', '42')` ↔ `{{setvar::score::42}}` (unprefixed)
- `spindle.variables.local.get(chatId, 'score')` ↔ `{{getvar::score}}`
- `spindle.variables.chat.set(chatId, 'hp', '100')` ↔ `{{setchatvar::hp::100}}` or `{{@hp = 100}}` (`@` prefix)
- `spindle.variables.chat.get(chatId, 'hp')` ↔ `{{getchatvar::hp}}` or `{{@hp}}`
- `spindle.variables.global.set('theme', 'dark')` ↔ `{{setgvar::theme::dark}}` or `{{$theme = dark}}` (`$` prefix)

The full chat-variable macro family also includes `{{incchatvar::key}}`, `{{decchatvar::key}}`, `{{addchatvar::key::value}}`, `{{haschatvar::key}}`, and `{{deletechatvar::key}}`, along with the inline `{{@key++}}` / `{{@key--}}` / `{{@key += n}}` shorthand.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, global variable methods use the `userId` resolved from the extension context. Chat-scoped methods always derive their owner from the chat record.
