# Prompt Interceptor Extension

An extension that prepends a tone directive to every generation, configurable from the frontend.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "Tone Adjuster",
  "identifier": "tone_adjuster",
  "author": "Dev",
  "github": "https://github.com/dev/tone-adjuster",
  "homepage": "https://github.com/dev/tone-adjuster",
  "permissions": ["interceptor"],
  "entry_backend": "dist/backend.js"
}
```

## `src/backend.ts`

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

// Load saved tone from storage, default to 'neutral'
let currentTone = 'neutral'

;(async () => {
  try {
    currentTone = await spindle.storage.read('tone.txt')
  } catch {
    // File doesn't exist yet, use default
  }
})()

spindle.registerInterceptor(async (messages, context) => {
  if (currentTone === 'neutral') return messages

  // Prepend a system instruction about tone
  return [
    {
      role: 'system' as const,
      content: `[Tone directive] Respond in a ${currentTone} tone.`,
    },
    ...messages,
  ]
}, 10) // Low priority = runs early

// Listen for tone changes from the frontend
spindle.onFrontendMessage(async (payload: any) => {
  if (payload.type === 'set_tone') {
    currentTone = payload.tone
    await spindle.storage.write('tone.txt', currentTone)
    spindle.sendToFrontend({ type: 'tone_updated', tone: currentTone })
    spindle.log.info(`Tone set to: ${currentTone}`)
  }
})

spindle.log.info('Tone Adjuster loaded!')
```

## How It Works

1. Loads the saved tone preference from storage on startup
2. Registers an interceptor with priority `10` (runs early in the chain)
3. If tone is not `neutral`, prepends a system message with the tone directive
4. Listens for `set_tone` messages from the frontend to update the tone
5. Persists the tone choice to storage so it survives restarts
