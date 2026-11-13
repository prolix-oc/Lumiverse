# Frontend-Only UI Extension

A word counter badge that tracks total words generated in the current session.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "Word Counter",
  "identifier": "word_counter",
  "author": "Dev",
  "github": "https://github.com/dev/word-counter",
  "homepage": "https://github.com/dev/word-counter",
  "permissions": [],
  "entry_frontend": "dist/frontend.js"
}
```

## `src/frontend.ts`

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  const removeStyle = ctx.dom.addStyle(`
    .wc-badge {
      position: fixed;
      bottom: 16px;
      right: 16px;
      padding: 6px 12px;
      background: var(--lumiverse-fill-subtle);
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      font-size: 11px;
      color: var(--lumiverse-text-muted);
      z-index: 100;
      pointer-events: none;
    }
  `)

  ctx.dom.inject('body', '<div class="wc-badge">Words: 0</div>')

  let totalWords = 0

  const unsub = ctx.events.on('GENERATION_ENDED', (payload: any) => {
    if (payload.content) {
      totalWords += payload.content.split(/\s+/).filter(Boolean).length
      const badge = ctx.dom.query('.wc-badge')
      if (badge) badge.textContent = `Words: ${totalWords.toLocaleString()}`
    }
  })

  // Return cleanup function
  return () => {
    unsub()
    removeStyle()
    ctx.dom.cleanup()
  }
}
```

## How It Works

1. Injects a small fixed badge in the bottom-right corner using Lumiverse CSS variables for theming
2. Subscribes to `GENERATION_ENDED` events
3. Counts words in each generation and updates the badge
4. Returns a cleanup function that removes the event listener, styles, and DOM elements
