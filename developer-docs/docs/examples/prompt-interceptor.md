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

---

# Structured Prefill Interceptor

An extension that injects `response_format` into the user's normal chat generation to enforce structured output via an interceptor.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "Structured Prefill",
  "identifier": "structured_prefill",
  "author": "Dev",
  "github": "https://github.com/dev/structured-prefill",
  "homepage": "https://github.com/dev/structured-prefill",
  "permissions": ["interceptor", "generation_parameters"],
  "entry_backend": "dist/backend.js"
}
```

## `src/backend.ts`

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

spindle.registerInterceptor(async (messages, context) => {
  // Look for an assistant prefill at the end of the prompt
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') {
    // No prefill — pass through unchanged
    return messages
  }

  const prefillText = last.content

  // Remove the prefill message from the prompt
  const filtered = messages.slice(0, -1)

  // Inject a json_schema that forces the model to start with the prefill text
  return {
    messages: filtered,
    parameters: {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'prefilled_response',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                pattern: `^${escapeRegex(prefillText)}`,
              },
            },
            required: ['text'],
          },
        },
      },
    },
  }
}, 200) // High priority number = runs late, after other interceptors

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

spindle.log.info('Structured Prefill loaded!')
```

## How It Works

1. Registers an interceptor with priority `200` (runs late so other interceptors process first)
2. Checks if the last message is an assistant-role prefill
3. If found, removes the prefill message and returns an `InterceptorResultDTO` with a `response_format` parameter that forces the LLM output to begin with the prefill text
4. The `generation_parameters` permission allows the `parameters` field to be merged into the outgoing request
5. Works with any OpenAI-compatible provider that supports `response_format: { type: "json_schema" }`
