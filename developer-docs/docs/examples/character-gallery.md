# Extension-Owned Character Gallery

A small full-stack example that generates character-scoped images, stores them with extension ownership tags, and renders a thumbnail gallery using `spindle.images.list()`.

## `spindle.json`

```json
{
  "version": "1.0.0",
  "name": "Character Gallery",
  "identifier": "character_gallery",
  "author": "Dev",
  "github": "https://github.com/dev/character-gallery",
  "homepage": "https://github.com/dev/character-gallery",
  "permissions": ["images", "image_gen", "chats"],
  "entry_backend": "dist/backend.js",
  "entry_frontend": "dist/frontend.js"
}
```

## `src/backend.ts`

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

type GalleryRequest =
  | { type: 'gallery_refresh' }
  | { type: 'gallery_generate'; prompt: string }

async function getActiveCharacterGallery(userId?: string) {
  const activeChat = await spindle.chats.getActive(userId)
  if (!activeChat) {
    return {
      chatId: null,
      characterId: null,
      images: [],
    }
  }

  const result = await spindle.images.list({
    onlyOwned: true,
    characterId: activeChat.character_id,
    specificity: 'sm',
    limit: 24,
    userId,
  })

  return {
    chatId: activeChat.id,
    characterId: activeChat.character_id,
    images: result.data,
  }
}

async function sendGallery(userId?: string) {
  const gallery = await getActiveCharacterGallery(userId)
  spindle.sendToFrontend({ type: 'gallery_state', ...gallery }, userId)
}

spindle.onFrontendMessage(async (payload: GalleryRequest, userId) => {
  if (payload.type === 'gallery_refresh') {
    await sendGallery(userId)
    return
  }

  if (payload.type === 'gallery_generate') {
    const activeChat = await spindle.chats.getActive(userId)
    if (!activeChat) {
      spindle.sendToFrontend({
        type: 'gallery_error',
        error: 'Open a chat before generating gallery images.',
      }, userId)
      return
    }

    await spindle.imageGen.generate({
      prompt: payload.prompt,
      owner_character_id: activeChat.character_id,
      owner_chat_id: activeChat.id,
      userId,
    })

    await sendGallery(userId)
  }
})

spindle.on('CHAT_SWITCHED', async (_payload, userId) => {
  await sendGallery(userId)
})

spindle.log.info('Character Gallery loaded!')
```

## `src/frontend.ts`

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  const removeStyle = ctx.dom.addStyle(`
    .cg-panel {
      margin: 12px;
      padding: 12px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill-subtle);
    }
    .cg-row {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
    }
    .cg-row input {
      flex: 1;
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill);
      color: var(--lumiverse-text);
    }
    .cg-row button {
      padding: 8px 12px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill);
      color: var(--lumiverse-text);
      cursor: pointer;
    }
    .cg-status {
      font-size: 12px;
      color: var(--lumiverse-text-muted);
      margin-bottom: 10px;
    }
    .cg-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
      gap: 8px;
    }
    .cg-grid img {
      width: 100%;
      aspect-ratio: 1 / 1;
      object-fit: cover;
      border-radius: calc(var(--lumiverse-radius) - 2px);
      border: 1px solid var(--lumiverse-border);
      background: var(--lumiverse-fill);
    }
  `)

  ctx.dom.inject('body', `
    <div class="cg-panel">
      <div class="cg-row">
        <input class="cg-prompt" placeholder="Prompt a new character image..." />
        <button class="cg-generate">Generate</button>
      </div>
      <div class="cg-status">Loading gallery...</div>
      <div class="cg-grid"></div>
    </div>
  `)

  const promptInput = ctx.dom.query('.cg-prompt') as HTMLInputElement | null
  const generateBtn = ctx.dom.query('.cg-generate') as HTMLButtonElement | null
  const statusEl = ctx.dom.query('.cg-status')
  const gridEl = ctx.dom.query('.cg-grid')

  function renderGallery(payload: any) {
    if (!statusEl || !gridEl) return

    if (!payload.characterId) {
      statusEl.textContent = 'Open a chat to see this extension\'s character gallery.'
      gridEl.innerHTML = ''
      return
    }

    statusEl.textContent = `Character ${payload.characterId} · ${payload.images.length} extension-owned image(s)`
    gridEl.innerHTML = payload.images
      .map((image: any) => `<img src="${image.url}" alt="${image.original_filename || 'Gallery image'}" />`)
      .join('')
  }

  generateBtn?.addEventListener('click', () => {
    const prompt = promptInput?.value.trim() || ''
    if (!prompt) return

    statusEl && (statusEl.textContent = 'Generating image...')
    ctx.sendToBackend({ type: 'gallery_generate', prompt })
  })

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (payload.type === 'gallery_state') {
      renderGallery(payload)
    } else if (payload.type === 'gallery_error' && statusEl) {
      statusEl.textContent = payload.error
    }
  })

  ctx.sendToBackend({ type: 'gallery_refresh' })

  return () => {
    unsub()
    removeStyle()
    ctx.dom.cleanup()
  }
}
```

## How It Works

1. The backend resolves the active chat, then uses `activeChat.character_id` as the gallery scope.
2. New generated images are saved with `owner_character_id`, `owner_chat_id`, and automatic `owner_extension_identifier` tagging.
3. `spindle.images.list({ onlyOwned: true, characterId, specificity: 'sm' })` returns only this extension's thumbnails for the active character.
4. The frontend renders `ImageDTO.url` directly, so it does not need to rebuild `/api/v1/images/...` paths manually.

## Why This Pattern Matters

- `onlyOwned: true` avoids pulling every image the user has ever uploaded.
- `characterId` keeps the gallery scoped to the current character.
- `specificity: 'sm'` returns thumbnail-sized image URLs that are better suited for lists and grids.
