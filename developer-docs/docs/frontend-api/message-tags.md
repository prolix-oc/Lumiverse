# Message Tag Interceptors

Extensions can intercept custom XML-like tags embedded in chat messages. This lets you build inline interactive elements — for example, a `<spotify-search query="...">` tag that triggers a search when rendered.

## `ctx.messages.registerTagInterceptor(options, handler)`

Register a handler that fires whenever a matching tag appears in a rendered message. Returns an unsubscribe function.

```ts
const unsub = ctx.messages.registerTagInterceptor(
  { tagName: 'my-action' },
  (payload) => {
    console.log('Tag found:', payload.tagName, payload.attrs, payload.content)
    console.log('In message:', payload.messageId, 'chat:', payload.chatId)
  }
)

// Unsubscribe later
unsub()
```

## SpindleMessageTagInterceptorOptions

| Field | Type | Description |
|---|---|---|
| `tagName` | `string` | The tag name to match (e.g. `'my-action'` matches `<my-action>`) |
| `attrs` | `Record<string, string>` | Optional. Only match tags that have these exact attribute values |
| `removeFromMessage` | `boolean` | Optional. If `true`, the matched tag is stripped from the rendered message output. During streaming, content is hidden as soon as the matching opening tag appears and replaced with a subtle inline "extension is processing" indicator. Normal rendering resumes after the closing tag arrives. |

## SpindleMessageTagIntercept (handler payload)

| Field | Type | Description |
|---|---|---|
| `extensionId` | `string` | Your extension's ID |
| `tagName` | `string` | The matched tag name |
| `attrs` | `Record<string, string>` | All attributes on the tag |
| `content` | `string` | Inner text content of the tag |
| `fullMatch` | `string` | The full matched tag string |
| `messageId` | `string?` | ID of the message containing the tag |
| `chatId` | `string?` | ID of the chat containing the message |
| `isUser` | `boolean?` | Whether the message is from the user |
| `isStreaming` | `boolean?` | Whether the message is still streaming |

## Example: Inline Search Tag

```ts
// Intercept <spotify-search query="..."> tags in messages
const unsub = ctx.messages.registerTagInterceptor(
  { tagName: 'spotify-search' },
  (payload) => {
    const query = payload.attrs.query
    if (query) {
      ctx.sendToBackend({ type: 'search', query })
    }
  }
)
```

When an LLM or user includes `<spotify-search query="chill vibes">` in a message, the handler fires and can trigger extension logic.
