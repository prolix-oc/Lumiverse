# Chat composer

`ctx.composer` reads and writes the draft in the chat composer (the message input of the open chat) and sends it through the host's own send path. Use it for dictation, quick-insert tools and voice commands instead of editing the textarea through the DOM.

Feature-detect both the optional API and the `composer-v1` host capability for compatibility with older hosts:

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  const composer = ctx.composer
  if (!composer || !(ctx.host.capabilities['composer-v1'] >= 1)) return

  const stop = composer.onChange((state) => {
    if (state.mounted) console.log(`draft for ${state.chatId}: ${state.text.length} chars`)
  })

  // Later, for example after speech-to-text:
  if (composer.getState().mounted) {
    composer.insertText('She nods slowly. ')
    composer.focus()
  }
}
```

| Member | Permission | Behavior |
|--------|-----------|----------|
| `getState()` | Free | `{ mounted, chatId, text }`. Returns `{ mounted: false, chatId: null, text: '' }` when no composer is on screen. |
| `onChange(handler)` | Free | Calls `handler` with the new state after the draft, the chat or the mounted state changes (typing, host actions, other extensions). Changes in the same task are delivered once. Returns an unsubscribe function. |
| `setText(text)` | Free | Replaces the draft. |
| `insertText(text, { at })` | Free | `at: 'caret'` (default) replaces the current selection and puts the caret after the new text; `'end'` appends. The text is inserted as is: add spaces or line breaks yourself. |
| `focus()` | Free | Focuses the composer textarea. |
| `send()` | `generation` | Does what the Send button does (see below). |

`setText` and `insertText` apply synchronously: `getState()` and `send()` right after them see the new draft. Editing the draft is free because nothing leaves the browser until the user (or a `generation`-gated `send()`) sends it. When the user has draft saving on, the host saves the new draft like a typed one.

### Calling from React effects

The synchronous writes use [React's `flushSync`](https://react.dev/reference/react-dom/flushSync). Call `setText` and `insertText` from event handlers, asynchronous callbacks, or `onChange` handlers. When calling from a React effect or lifecycle callback, defer the write and any dependent reads or sends to a microtask, after React has finished committing:

```tsx
useEffect(() => {
  let active = true
  queueMicrotask(() => {
    if (active && composer.getState().mounted) {
      composer.setText(transcript)
      // getState() or send() here sees the updated draft.
    }
  })
  return () => { active = false }
}, [composer, transcript])
```

Calling a synchronous write directly inside an effect produces a React warning; the new draft is applied on a later render, so an immediate read or send can still use the previous draft.

## Sending

`send()` runs the host's send path for the open chat, the same one as the Send button and Enter:

- the message uses the active persona's name and id (none in temporary chats), and includes pending attachments;
- in group chats, `@mentions` pick and queue the responding members, as when typing;
- in multiplayer rooms, turn and freeform-window rules apply;
- an empty draft without attachments asks for a fresh reply, like an empty Send.

It resolves when the host has created the message and started the generation. It rejects with `COMPOSER_BUSY` if a send or a generation is already running in this chat. Host-side failures (for example, the provider rejects the request) are shown to the user as toasts, as for the Send button, and do not reject.

## Errors

- `setText`, `insertText`, `focus` and `send` throw `COMPOSER_UNAVAILABLE` when no composer is mounted (for example, outside a chat page, or while an extension replaces the `InputArea` component). `getState()` never throws for this; check `mounted`.
- `send()` rejects with `PERMISSION_DENIED:generation` without the `generation` permission.
- Calls after frontend unload throw `SPINDLE_FRONTEND_INACTIVE`. `onChange` subscriptions end when the frontend unloads.
