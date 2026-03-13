# Minimal Backend Extension

A simple extension that counts messages and exposes a `{{msg_count}}` macro.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "Message Logger",
  "identifier": "message_logger",
  "author": "Dev",
  "github": "https://github.com/dev/message-logger",
  "homepage": "https://github.com/dev/message-logger",
  "permissions": []
}
```

## `src/backend.ts`

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

let messageCount = 0

spindle.registerMacro({
  name: 'msg_count',
  category: 'extension:message_logger',
  description: 'Total messages sent this session',
  returnType: 'integer',
  handler: '',
})
spindle.updateMacroValue('msg_count', '0')

spindle.on('MESSAGE_SENT', (payload: any) => {
  messageCount++
  spindle.updateMacroValue('msg_count', String(messageCount))
  spindle.log.info(`Message #${messageCount}: ${payload.message?.content?.slice(0, 80)}`)
})

spindle.log.info('Message Logger loaded!')
```

## How It Works

1. Registers a `msg_count` macro using the push model (empty handler)
2. Subscribes to `MESSAGE_SENT` events
3. On each message, increments the counter and pushes the new value
4. Users can include `{{msg_count}}` in prompts to inject the current count
