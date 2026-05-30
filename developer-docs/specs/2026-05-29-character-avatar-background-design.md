# Character Avatar Background

Auto-fill the chat background with the active character's art for a cozy, immersive chat experience — no manual wallpaper upload needed.

## Motivation

Online chat providers like Chub.ai automatically use the character's portrait as the chat background, creating a more immersive feel. Lumiverse already has character avatars, a gallery system, and a wallpaper renderer — but there's no bridge between them. Users must manually upload a wallpaper per chat. This feature closes that gap.

## Scope

**Phase 1 (this spec):**
- Toggle to auto-use character avatar as chat background
- Blur slider for all wallpapers
- Greeting-aware background: user can assign gallery images to specific greetings
- Greeting index persistence in chat metadata

**Phase 2 (future):**
- Full gallery picker modal (choose from avatar/gallery/upload) with position, zoom, and rotation controls
- Per-character background display overrides

## Wallpaper Priority Stack

From highest to lowest priority:

1. AI-generated scene backgrounds (existing)
2. Per-chat wallpaper — manually set (existing)
3. Global wallpaper — manually set (existing)
4. **Character avatar background (new) — the cozy default**

The character avatar background only renders when nothing higher-priority is active and the `useCharacterBackground` setting is enabled.

## Data Model Changes

### Settings Slice

Add to `WallpaperSettings`:

```ts
interface WallpaperSettings {
  global: WallpaperRef | null
  opacity: number          // existing, 0-1
  fit: 'cover' | 'contain' | 'fill'  // existing
  blur: number             // NEW — 0-20, default 0, in px
}
```

Add to the settings store (top-level, persisted):

```ts
useCharacterBackground: boolean  // NEW — default false
```

### Character Extensions

Greeting-to-image mapping stored in the character's existing `extensions` field:

```ts
character.extensions.greeting_backgrounds: {
  [greetingIndex: number]: string  // image_id from character gallery
  // index 0 = default greeting (first_mes)
  // index 1+ = alternate greetings (matching alternate_greetings array order)
}
```

No database migration needed — `extensions` is already a flexible `Record<string, any>`.

### Chat Metadata

Track which greeting is active for background resolution:

```ts
chat.metadata.activeGreetingIndex: number  // default 0
```

Written via the existing `chatsApi.patchMetadata` endpoint.

## Resolution Logic

Implemented in `ChatView.tsx`. The current logic:

```
effectiveWallpaper = activeChatWallpaper ?? wallpaper.global
```

Becomes:

```
effectiveWallpaper = activeChatWallpaper ?? wallpaper.global ?? characterBackground
```

Where `characterBackground` is resolved (only when `useCharacterBackground` is enabled):

1. Read `activeGreetingIndex` from chat metadata (default 0)
2. Look up `character.extensions.greeting_backgrounds[activeGreetingIndex]`
   - If a gallery `image_id` is mapped, use it
3. Otherwise fall back to `character.image_id` (the avatar)
4. If the character has no avatar, yield `null` (no background)

The resolved image is wrapped as `WallpaperRef { image_id, type: 'image' }` and flows through the existing wallpaper rendering pipeline.

## UI Changes

### WallpaperPanel.tsx

1. **Toggle** — "Use Character Avatar as Background" at the top of the panel, above Global Wallpaper. Uses the existing `Toggle` component. Info text below: "Automatically uses the character's art as the chat background when no wallpaper is set."

2. **Blur slider** — Added to the Display Settings section after the opacity slider. Label: `Blur (Xpx)`. Range 0-20, step 1, default 0. Applied as `filter: blur(Xpx)` on `.wallpaperLayer` and `.wallpaperVideoLayer`.

### GreetingPickerModal.tsx

Per greeting card, add a small image button in the card header area. Clicking it opens a mini picker showing the character's gallery thumbnails (fetched via `characterGalleryApi.list()`). Selecting an image writes to `character.extensions.greeting_backgrounds[greetingIndex]` via `charactersApi.update()`. If a greeting already has a mapped image, show a small thumbnail on the card.

### ChatView.tsx

- Extend `effectiveWallpaper` resolution with the character background fallback
- Apply `blur` setting as inline `filter` style on the wallpaper layer divs
- Read `activeGreetingIndex` from `activeChatMetadata`
- When greeting changes via `GreetingNav`, update metadata and re-resolve background

### ChatView.module.css

No structural changes. The blur is applied via inline style on the existing `.wallpaperLayer` and `.wallpaperVideoLayer` classes.

## Data Flow

### Chat Open

1. Chat loads — `activeCharacterId` and `activeChatMetadata` are set (existing behavior)
2. If `useCharacterBackground` is enabled and no higher-priority wallpaper exists:
   - Read `activeGreetingIndex` from chat metadata (default 0)
   - Resolve gallery image or avatar
   - Render through existing wallpaper layer

### Greeting Switch

1. `GreetingNav.handleSelect` fires with the new greeting index
2. Persist `activeGreetingIndex` to chat metadata via `chatsApi.patchMetadata`
3. Store updates, ChatView re-renders
4. Background crossfades using existing `transition: opacity 400ms ease`

### Gallery Image Assignment

1. User clicks image button on a greeting card in GreetingPickerModal
2. Mini picker shows character gallery thumbnails
3. User selects — writes to `character.extensions.greeting_backgrounds` via `charactersApi.update`
4. If this greeting is currently active, background updates immediately

### Chat Switch

- Different character: background swaps to new character's avatar/greeting image
- Chat with per-chat wallpaper: that wallpaper takes priority, character background hidden

## Infrastructure Reuse

- **No new API endpoints** — uses existing characters, character-gallery, chats, and images APIs
- **No new database tables or migrations** — uses existing `extensions` and `metadata` fields
- **No new WebSocket events** — reactive via Zustand store updates
- **No new components** — all changes fit into existing panels and modals

## Files Modified

| File | Change |
|------|--------|
| `frontend/src/types/store.ts` | Add `blur` to `WallpaperSettings`, add `useCharacterBackground` to settings |
| `frontend/src/store/slices/settings.ts` | Add defaults for new fields, persist them |
| `frontend/src/components/panels/WallpaperPanel.tsx` | Add toggle + blur slider |
| `frontend/src/components/chat/ChatView.tsx` | Extend wallpaper resolution, apply blur |
| `frontend/src/components/chat/ChatView.module.css` | No structural changes (blur via inline style) |
| `frontend/src/components/modals/GreetingPickerModal.tsx` | Add gallery image picker per greeting |
| `frontend/src/components/chat/GreetingNav.tsx` | Persist `activeGreetingIndex` to chat metadata on switch |
