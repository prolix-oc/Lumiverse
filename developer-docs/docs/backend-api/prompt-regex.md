# Prompt Regex Ownership

Regex scripts with `target: "prompt"` rewrite chat history before it reaches the LLM. By default the host runs this pass itself during prompt assembly. An extension can take it over for chats it owns, so it applies those rules in its own interceptor instead.

Use this when you already transform the prompt in a [`registerInterceptor`](interceptors.md) handler and want a single, consistent pass instead of the host's pass plus yours.

`spindle.promptRegex` is optional. Feature-detect it before use. No permission is required.

```ts
if (typeof spindle.promptRegex?.setOwnedChats === 'function') {
  spindle.promptRegex.setOwnedChats(['chat-id-1', 'chat-id-2'])
}
```

## Ownership

You declare ownership by publishing the chat IDs you handle. For an owned chat the host skips its own `target: "prompt"` regex pass; for every other chat it runs that pass as usual.

```ts
spindle.promptRegex.setOwnedChats(myOwnedChatIds)
```

- Pass the **full** owned set each call. It replaces the previous set.
- Pass an empty array to release ownership. The host resumes its own pass.
- Ownership is dropped automatically when your extension unloads.

Call this whenever your owned set changes, such as when the user opens a chat you handle. The host reads the latest set at generation time.

## Applying the regex yourself

When you own a chat, the host does not apply its `target: "prompt"` scripts, so you must apply them. Do this in a [`registerInterceptor`](interceptors.md) handler, which runs after assembly on the final message array.

```ts
spindle.registerInterceptor(async (messages, context) => {
  if (!iOwn(context.chatId)) return messages

  // Apply your target:prompt regex over `messages` here.
  return messages
})
```

The invariant is **apply if you own**. If you declare ownership but cannot apply (your runtime is unavailable, a fetch fails), the prompt ships with no prompt regex at all, because the host already skipped its pass. Release ownership in that case so the host runs its own pass, and log loudly when an owned chat would otherwise ship un-transformed.

### Chat history flag

Messages passed to your interceptor carry `__isChatHistory` when they are genuine chat-history turns, as opposed to depth-injected world info, preset, or author's note blocks spliced into the history range. The host gates `min_depth` / `max_depth` on chat-history messages only, so use this flag to rebuild the same depth frame and to number turns. Injected non-history blocks must not shift the index of real turns.

```ts
interface LlmMessageDTO {
  role: 'system' | 'user' | 'assistant'
  content: string | LlmMessagePartDTO[]
  name?: string
  __isChatHistory?: boolean // host-set, present only on interceptor input
}
```

The flag is set by the host on interceptor input only. It is never sent to the LLM.

## `spindle.promptRegex.setOwnedChats(chatIds)`

| Param | Type | Description |
|---|---|---|
| `chatIds` | `string[]` | The full set of chats whose `target: "prompt"` regex you apply yourself. Replaces the previous set. Empty array releases ownership. |

Returns `void`. The call is a hint and takes effect on the next generation for those chats.
