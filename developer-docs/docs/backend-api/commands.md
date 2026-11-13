# Command Palette Commands

Register custom commands that appear in the Lumiverse command palette (Cmd/Ctrl+K). When users search and select your command, the extension receives the invocation with full UI context.

No permission is required. This is a free-tier API.

## Quick Start

```ts
// Register commands
spindle.commands.register([
  {
    id: 'summarize-chat',
    label: 'Summarize Chat',
    description: 'Generate a summary of the current conversation',
    keywords: ['summary', 'recap', 'tldr'],
    scope: 'chat',
  },
  {
    id: 'export-notes',
    label: 'Export Notes',
    description: 'Export conversation notes as markdown',
    keywords: ['export', 'download', 'markdown', 'notes'],
    scope: 'chat-idle',
  },
])

// Handle invocations
spindle.commands.onInvoked((commandId, context) => {
  switch (commandId) {
    case 'summarize-chat':
      summarizeChat(context.chatId)
      break
    case 'export-notes':
      exportNotes(context.chatId)
      break
  }
})
```

## Methods

### `spindle.commands.register(commands)`

Register (or replace) all command palette entries for this extension. Each call **replaces the full set** — pass the complete list of commands you want visible.

```ts
spindle.commands.register([
  {
    id: 'my-command',
    label: 'Do Something',
    description: 'Performs a useful action',
    keywords: ['do', 'action'],
    scope: 'global',
  },
])
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique identifier within your extension (max 100 chars) |
| `label` | `string` | Yes | Display name shown in the palette (max 80 chars) |
| `description` | `string` | No | Help text shown below the label (max 200 chars) |
| `keywords` | `string[]` | No | Search keywords for fuzzy matching (max 10, 30 chars each) |
| `scope` | `string` | No | Visibility restriction (default: `'global'`) |

**Limits:** Maximum **20 commands per extension**. Excess commands are silently truncated.

### `spindle.commands.unregister(commandIds?)`

Remove specific commands by ID, or all commands if no IDs are given.

```ts
// Remove specific commands
spindle.commands.unregister(['export-notes'])

// Remove all commands
spindle.commands.unregister()
```

### `spindle.commands.onInvoked(handler)`

Register a handler called when the user selects one of your commands. Returns an unsubscribe function.

```ts
const unsub = spindle.commands.onInvoked((commandId, context) => {
  // commandId: the `id` from your registration
  // context: snapshot of the frontend's current state
})

// Later, stop listening:
unsub()
```

**Context object:**

| Field | Type | Description |
|---|---|---|
| `route` | `string` | Current URL path (e.g. `"/chat/abc-123"`, `"/"`) |
| `chatId` | `string?` | Active chat ID, if in a chat view |
| `characterId` | `string?` | Active character ID, if available |
| `isGroupChat` | `boolean?` | Whether the active chat is a group chat |
| `trigger` | `{ type: 'keybind'; bindingId: string; scope: 'focused' \| 'global' }?` | Present when invoked through a configured desktop key binding |

Hosts advertising `command-session-routing-v1` also pass an optional third callback
argument, `origin: { userId: string; frontendSessionId?: string }`. It comes from
the authenticated WebSocket, separately from the caller-supplied context. Use it
when a command needs to hand work back to the invoking document, especially for
microphone input. Do not broadcast a capture trigger or infer its owner from
`context.trigger`, chat IDs, or the most recently active subscriber. Older clients
can omit document identity; fail closed for actions requiring a specific window.
The optional callback argument is backward compatible with 0.6.69's two-argument
handler type; feature-detect the host capability before depending on it.

```ts
spindle.commands.onInvoked((commandId, context, origin?: { userId: string; frontendSessionId?: string }) => {
  if (!origin?.frontendSessionId) return
  spindle.sendToFrontend({ action: commandId }, origin.userId, {
    frontendSessionId: origin.frontendSessionId,
  })
})
```

## Desktop key bindings

Registered commands are available in **Settings → Key Bindings** in Desktop's
integrated frontend.
Focused bindings need no extra setup. The owner can enable global bindings with
one native confirmation for this instance/account, then configure individual
shortcuts in the frontend without repeated approval. Disabling global bindings
in Settings changes this account's bindings and shared desktop actions to focused mode.
No additional Spindle permission is needed to receive an invocation of an already
registered command. Extensions receive command events rather than a raw keyboard stream.

```ts
spindle.commands.onInvoked((commandId, context) => {
  if (commandId !== 'summarize-chat') return
  if (context.trigger?.type === 'keybind') {
    console.log('Desktop binding:', context.trigger.bindingId, context.trigger.scope)
  }
  summarizeChat(context.chatId)
})
```

### Configure a binding inside extension UI

A frontend extension can embed the host's binding editor directly in its own
drawer panel or settings tab. The backend must first register the action through
`spindle.commands.register()`. Feature-detect `components.mountKeybindingEditor`
or the `desktop-keybindings-editor-v1` frontend host capability, and check for a
desktop client. There is no trip through the host Settings screen.

```ts
// In a registered drawer/settings tab, after its root is available:
if (ctx.client?.getInfo().bridges.desktop && ctx.components.mountKeybindingEditor) {
  const target = document.createElement('div')
  tab.root.append(target)
  const editor = ctx.components.mountKeybindingEditor(target, {
    commandId: 'summarize-chat', // this extension's registered backend command ID
  })
  // Call editor.destroy() when this part of your UI is removed.
}
```

The control edits only that extension's selected registered command and uses the
same native opt-in for global bindings. The container must belong to the current
extension's live UI placement. Disabling/unloading the extension or revoking the
placement closes the mounted control. The binding persists on this desktop and
also appears in central Settings. Browser/mobile clients do not expose desktop
configuration; older desktop clients may need an app update.

The same command scopes and active extension checks apply. Bindings are local to the
desktop installation and scoped to the selected instance, signed-in account, and
extension installation. The integrated browser must remain open and signed in;
global bindings can work while its window is hidden or in the background. Closing
the browser, signing out, disabling the extension, or unregistering the command
stops delivery. Backend-only extensions can register commands too.

`context.trigger` is informational frontend context, not proof of authorization or
a native gesture token. Existing permission and ownership checks still apply.
Global shortcuts are supported on macOS, Windows and Linux X11. Native Wayland
sessions currently support app-focused bindings only.

## Scopes

Scopes control when a command is visible in the palette, based on the user's current page:

| Scope | Visible When |
|---|---|
| `'global'` | Always (default) |
| `'chat'` | User is viewing any chat |
| `'chat-idle'` | User is in a chat and not currently streaming |
| `'landing'` | User is on the home page |
| `'character'` | User is on a character page |

If `scope` is omitted, the command defaults to `'global'`.

## Contextual Commands

Commands are designed to be **contextual**. You can re-register with different sets of commands based on the current state of the app. Subscribe to Lumiverse events and call `register()` again whenever your command set should change:

```ts
// Start with a base set
spindle.commands.register([
  { id: 'configure', label: 'Configure Extension', description: 'Open settings', scope: 'global' },
])

// Add chat-specific commands when a chat becomes active
spindle.on('CHAT_CHANGED', (payload) => {
  const baseCommands = [
    { id: 'configure', label: 'Configure Extension', description: 'Open settings', scope: 'global' },
  ]

  if (payload?.chatId) {
    baseCommands.push({
      id: 'analyze-chat',
      label: 'Analyze Conversation',
      description: 'Run sentiment analysis on the current chat',
      scope: 'chat',
    })
  }

  spindle.commands.register(baseCommands)
})
```

## Presentation

Extension commands appear in the **Extensions** group in the command palette, alongside any drawer tabs your extension registers. They are searchable by label, description, keywords, and your extension name.

Your extension name (from `spindle.json`) is automatically included as a search keyword — users can always find your commands by searching for your extension name.

## Example: Translation Extension

```ts
const LANGUAGES = ['Spanish', 'French', 'Japanese', 'German']

// Register a translate command for each language
spindle.commands.register(
  LANGUAGES.map((lang) => ({
    id: `translate-${lang.toLowerCase()}`,
    label: `Translate to ${lang}`,
    description: `Translate the last message to ${lang}`,
    keywords: ['translate', 'language', lang.toLowerCase()],
    scope: 'chat-idle',
  }))
)

spindle.commands.onInvoked(async (commandId, context) => {
  const lang = commandId.replace('translate-', '')
  if (!context.chatId) return

  const messages = await spindle.chat.getMessages(context.chatId)
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage) return

  const result = await spindle.generate.quiet({
    type: 'quiet',
    messages: [
      { role: 'system', content: `Translate the following text to ${lang}. Output only the translation.` },
      { role: 'user', content: lastMessage.content },
    ],
  })

  spindle.toast.success(`Translation complete`)
})
```

## Cleanup

Commands are automatically unregistered when your extension is unloaded or disabled. You don't need to clean up manually — but you can call `spindle.commands.unregister()` at any time to remove your commands proactively.
