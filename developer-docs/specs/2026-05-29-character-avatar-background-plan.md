# Character Avatar Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggle that auto-fills the chat background with the active character's avatar, with blur support and greeting-aware background switching via gallery image mapping.

**Architecture:** Frontend-only resolution. When `useCharacterBackground` is enabled and no higher-priority wallpaper exists, ChatView resolves the character's avatar (or a greeting-mapped gallery image) and renders it through the existing wallpaper layer. Greeting-to-image mappings are stored in `character.extensions.greeting_backgrounds`. A new blur slider applies to all wallpaper types.

**Tech Stack:** React, Zustand, TypeScript, CSS Modules. Existing Lumiverse APIs (characters, character-gallery, chats, images, settings).

---

### Task 1: Add `blur` to WallpaperSettings and `useCharacterBackground` to settings

**Files:**
- Modify: `frontend/src/types/store.ts` — `WallpaperSettings` interface and `SettingsSlice` interface
- Modify: `frontend/src/store/slices/settings.ts` — defaults and DATA_KEYS

- [ ] **Step 1: Add `blur` to `WallpaperSettings` interface**

In `frontend/src/types/store.ts`, find:

```ts
export interface WallpaperSettings {
  global: WallpaperRef | null
  opacity: number
  fit: 'cover' | 'contain' | 'fill'
}
```

Replace with:

```ts
export interface WallpaperSettings {
  global: WallpaperRef | null
  opacity: number
  fit: 'cover' | 'contain' | 'fill'
  blur: number
}
```

- [ ] **Step 2: Add `useCharacterBackground` to `SettingsSlice` interface**

In `frontend/src/types/store.ts`, find:

```ts
  wallpaper: WallpaperSettings
```

Add after it:

```ts
  useCharacterBackground: boolean
```

- [ ] **Step 3: Add default values in settings slice**

In `frontend/src/store/slices/settings.ts`, find:

```ts
  wallpaper: {
    global: null,
    opacity: 0.3,
    fit: 'cover',
  },
```

Replace with:

```ts
  wallpaper: {
    global: null,
    opacity: 0.3,
    fit: 'cover',
    blur: 0,
  },
  useCharacterBackground: false,
```

- [ ] **Step 4: Register `useCharacterBackground` in DATA_KEYS**

In `frontend/src/store/slices/settings.ts`, find:

```ts
  // Wallpaper settings
  'wallpaper',
```

Add after it:

```ts
  'useCharacterBackground',
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types/store.ts frontend/src/store/slices/settings.ts
git commit -m "feat: add blur to WallpaperSettings and useCharacterBackground setting"
```

---

### Task 2: Add blur slider and character background toggle to WallpaperPanel

**Files:**
- Modify: `frontend/src/components/panels/WallpaperPanel.tsx`

- [ ] **Step 1: Add the toggle and blur slider to WallpaperPanel**

In `frontend/src/components/panels/WallpaperPanel.tsx`, add the Toggle import. Find:

```ts
import { FormField, Select, EditorSection } from '@/components/shared/FormComponents'
```

Replace with:

```ts
import { FormField, Select, EditorSection } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
```

- [ ] **Step 2: Read `useCharacterBackground` from the store**

Find:

```ts
  const wallpaper = useStore((s) => s.wallpaper)
  const setWallpaper = useStore((s) => s.setWallpaper)
```

Replace with:

```ts
  const wallpaper = useStore((s) => s.wallpaper)
  const setWallpaper = useStore((s) => s.setWallpaper)
  const useCharacterBackground = useStore((s) => s.useCharacterBackground)
  const setSetting = useStore((s) => s.setSetting)
```

- [ ] **Step 3: Add the toggle UI at the top of the panel**

Find:

```tsx
      {/* Global wallpaper section */}
      <span className={styles.scopeLabel}>Global Wallpaper</span>
```

Add before it:

```tsx
      {/* Character avatar background toggle */}
      <div className={styles.actions} style={{ alignItems: 'center' }}>
        <Toggle.Switch
          checked={useCharacterBackground}
          onChange={(v) => setSetting('useCharacterBackground', v)}
        />
        <span style={{ fontSize: 'calc(13px * var(--lumiverse-font-scale, 1))' }}>
          Use Character Avatar as Background
        </span>
      </div>
      <div className={styles.info}>
        Automatically uses the character's art as the chat background when no wallpaper is set.
      </div>

      <hr className={styles.divider} />
```

- [ ] **Step 4: Add blur slider to Display Settings section**

Find the opacity FormField inside the EditorSection:

```tsx
        <FormField label={`Opacity (${Math.round((wallpaper.opacity ?? 0.3) * 100)}%)`}>
          <input
            className={styles.slider}
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round((wallpaper.opacity ?? 0.3) * 100)}
            onChange={(e) => setWallpaper({ opacity: Number(e.target.value) / 100 })}
          />
        </FormField>
```

Add after it (before the Fit Mode FormField):

```tsx
        <FormField label={`Blur (${wallpaper.blur ?? 0}px)`}>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={20}
            step={1}
            value={wallpaper.blur ?? 0}
            onChange={(e) => setWallpaper({ blur: Number(e.target.value) })}
          />
        </FormField>
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/panels/WallpaperPanel.tsx
git commit -m "feat: add character background toggle and blur slider to WallpaperPanel"
```

---

### Task 3: Extend ChatView wallpaper resolution with character background fallback

**Files:**
- Modify: `frontend/src/components/chat/ChatView.tsx`

- [ ] **Step 1: Add store selectors for character background resolution**

In `frontend/src/components/chat/ChatView.tsx`, find:

```ts
  const wallpaper = useStore((s) => s.wallpaper)
```

Add after it:

```ts
  const useCharacterBackground = useStore((s) => s.useCharacterBackground)
```

- [ ] **Step 2: Add character background resolution logic**

Find:

```ts
  const activeChatWallpaper = useStore((s) => s.activeChatWallpaper)

  // Resolve effective wallpaper: per-chat overrides global
  const effectiveWallpaper = activeChatWallpaper ?? wallpaper.global
```

Replace with:

```ts
  const activeChatWallpaper = useStore((s) => s.activeChatWallpaper)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)

  const characterBackground = useMemo((): WallpaperRef | null => {
    if (!useCharacterBackground || !activeCharacterId) return null
    const character = characters.find((c) => c.id === activeCharacterId)
    if (!character) return null

    const greetingIndex = (activeChatMetadata?.activeGreetingIndex as number) ?? 0
    const greetingBgs = character.extensions?.greeting_backgrounds as Record<number, string> | undefined
    const mappedImageId = greetingBgs?.[greetingIndex]

    const imageId = mappedImageId || character.image_id
    if (!imageId) return null
    return { image_id: imageId, type: 'image' }
  }, [useCharacterBackground, activeCharacterId, characters, activeChatMetadata])

  // Resolve effective wallpaper: per-chat > global > character avatar
  const effectiveWallpaper = activeChatWallpaper ?? wallpaper.global ?? characterBackground
```

Also ensure `useMemo` is in the imports at the top of the file. Find the React import line and add `useMemo` if not already present.

- [ ] **Step 3: Apply blur to wallpaper layers**

Find the image wallpaper layer:

```tsx
      {wallpaperUrl && !wallpaperIsVideo && (
        <div
          className={styles.wallpaperLayer}
          style={{
            backgroundImage: `url("${wallpaperUrl}")`,
            opacity: sceneBackground ? 0 : wallpaperOpacity,
            objectFit: wallpaperFit,
            backgroundSize: wallpaperFit === 'fill' ? '100% 100%' : wallpaperFit,
          }}
        />
      )}
```

Replace with:

```tsx
      {wallpaperUrl && !wallpaperIsVideo && (
        <div
          className={styles.wallpaperLayer}
          style={{
            backgroundImage: `url("${wallpaperUrl}")`,
            opacity: sceneBackground ? 0 : wallpaperOpacity,
            objectFit: wallpaperFit,
            backgroundSize: wallpaperFit === 'fill' ? '100% 100%' : wallpaperFit,
            filter: (wallpaper.blur ?? 0) > 0 ? `blur(${wallpaper.blur}px)` : undefined,
          }}
        />
      )}
```

Find the video wallpaper layer:

```tsx
      {wallpaperUrl && wallpaperIsVideo && (
        <video
          ref={videoRef}
          className={styles.wallpaperVideoLayer}
          src={wallpaperUrl}
          autoPlay
          muted
          loop
          playsInline
          style={{
            opacity: sceneBackground ? 0 : wallpaperOpacity,
            objectFit: wallpaperFit === 'fill' ? 'fill' : wallpaperFit,
          }}
        />
      )}
```

Replace with:

```tsx
      {wallpaperUrl && wallpaperIsVideo && (
        <video
          ref={videoRef}
          className={styles.wallpaperVideoLayer}
          src={wallpaperUrl}
          autoPlay
          muted
          loop
          playsInline
          style={{
            opacity: sceneBackground ? 0 : wallpaperOpacity,
            objectFit: wallpaperFit === 'fill' ? 'fill' : wallpaperFit,
            filter: (wallpaper.blur ?? 0) > 0 ? `blur(${wallpaper.blur}px)` : undefined,
          }}
        />
      )}
```

- [ ] **Step 4: Update `hasAnyBackground` to include character background**

Find:

```ts
  const hasAnyBackground = !!(sceneBackground || wallpaperUrl)
```

This already works because `wallpaperUrl` is derived from `effectiveWallpaper`, which now includes `characterBackground`. No change needed — just verify this is correct.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/chat/ChatView.tsx
git commit -m "feat: resolve character avatar as wallpaper fallback and apply blur filter"
```

---

### Task 4: Persist greeting index on greeting switch

**Files:**
- Modify: `frontend/src/components/chat/GreetingNav.tsx`

- [ ] **Step 1: Import chats API**

In `frontend/src/components/chat/GreetingNav.tsx`, find:

```ts
import { messagesApi } from '@/api/chats'
```

Replace with:

```ts
import { messagesApi, chatsApi } from '@/api/chats'
```

Verify `chatsApi.patchMetadata` exists. Check `frontend/src/api/chats.ts`:

```ts
patchMetadata(chatId: string, metadata: Record<string, any>)
```

- [ ] **Step 2: Persist `activeGreetingIndex` in handleSelect**

In `frontend/src/components/chat/GreetingNav.tsx`, find inside `handleSelect`:

```ts
      if (contentChanged) {
        try {
          const updated = await messagesApi.update(chatId, message.id, { content: newContent })
          updateMessage(updated.id, updated)
        } catch (err) {
          console.error('[GreetingNav] Failed to update greeting:', err)
        }
      }
      setPickerOpen(false)
```

Replace with:

```ts
      if (contentChanged) {
        try {
          const updated = await messagesApi.update(chatId, message.id, { content: newContent })
          updateMessage(updated.id, updated)
        } catch (err) {
          console.error('[GreetingNav] Failed to update greeting:', err)
        }
      }

      chatsApi.patchMetadata(chatId, { activeGreetingIndex: greetingIndex }).then(() => {
        const store = useStore.getState()
        const prev = store.activeChatMetadata ?? {}
        store.setActiveChatMetadata({ ...prev, activeGreetingIndex: greetingIndex })
      }).catch(() => {})

      setPickerOpen(false)
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/chat/GreetingNav.tsx
git commit -m "feat: persist activeGreetingIndex to chat metadata on greeting switch"
```

---

### Task 5: Add gallery image picker to GreetingPickerModal

**Files:**
- Modify: `frontend/src/components/modals/GreetingPickerModal.tsx`
- Modify: `frontend/src/components/modals/GreetingPickerModal.module.css`

- [ ] **Step 1: Add imports and state for gallery picker**

In `frontend/src/components/modals/GreetingPickerModal.tsx`, find:

```ts
import { useEffect, useRef } from 'react'
import { Check, Image as ImageIcon } from 'lucide-react'
```

Replace with:

```ts
import { useEffect, useRef, useState, useCallback } from 'react'
import { Check, Image as ImageIcon, ImagePlus, X } from 'lucide-react'
import { characterGalleryApi } from '@/api/character-gallery'
import { charactersApi } from '@/api/characters'
import { imagesApi } from '@/api/images'
import type { CharacterGalleryItem } from '@/types/api'
```

- [ ] **Step 2: Add gallery state and fetching**

Inside the `GreetingPickerModal` component function, after the `activeCardRef` declaration, add:

```tsx
  const [galleryItems, setGalleryItems] = useState<CharacterGalleryItem[]>([])
  const [galleryOpenIndex, setGalleryOpenIndex] = useState<number | null>(null)
  const greetingBgs = (character.extensions?.greeting_backgrounds ?? {}) as Record<number, string>

  useEffect(() => {
    characterGalleryApi.list(character.id).then(setGalleryItems).catch(() => {})
  }, [character.id])

  const assignBackground = useCallback(async (greetingIndex: number, imageId: string | null) => {
    const updated = { ...greetingBgs }
    if (imageId) {
      updated[greetingIndex] = imageId
    } else {
      delete updated[greetingIndex]
    }
    try {
      await charactersApi.update(character.id, {
        extensions: { ...character.extensions, greeting_backgrounds: updated },
      })
      character.extensions = { ...character.extensions, greeting_backgrounds: updated }
    } catch {}
    setGalleryOpenIndex(null)
  }, [character, greetingBgs])
```

- [ ] **Step 3: Add gallery picker UI to each greeting card**

Find the badge row inside the greeting card map:

```tsx
                {(hasImage || isActive) && (
                  <span className={styles.badgeRow}>
                    {hasImage && (
                      <span className={styles.mediaBadge}>
                        <ImageIcon size={10} />
                        Image
                      </span>
                    )}
                    {isActive && (
                      <span className={styles.activeBadge}>
                        <Check size={10} />
                        Active
                      </span>
                    )}
                  </span>
                )}
```

Replace with:

```tsx
                <span className={styles.badgeRow}>
                  {hasImage && (
                    <span className={styles.mediaBadge}>
                      <ImageIcon size={10} />
                      Image
                    </span>
                  )}
                  {isActive && (
                    <span className={styles.activeBadge}>
                      <Check size={10} />
                      Active
                    </span>
                  )}
                  <button
                    type="button"
                    className={styles.bgPickerBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      setGalleryOpenIndex(galleryOpenIndex === i ? null : i)
                    }}
                    title="Set background image for this greeting"
                  >
                    {greetingBgs[i] ? (
                      <img
                        src={imagesApi.url(greetingBgs[i]) + '?size=sm'}
                        alt=""
                        className={styles.bgPickerThumb}
                      />
                    ) : (
                      <ImagePlus size={12} />
                    )}
                  </button>
                </span>
```

- [ ] **Step 4: Add gallery picker dropdown below the card header**

Find right after the card header div closing `</div>`:

```tsx
              <div className={styles.cardPreview}>{g.content}</div>
```

Add before it:

```tsx
              {galleryOpenIndex === i && (
                <div className={styles.bgGalleryPicker} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.bgGalleryGrid}>
                    {galleryItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={clsx(
                          styles.bgGalleryItem,
                          greetingBgs[i] === item.image_id && styles.bgGalleryItemActive,
                        )}
                        onClick={() => assignBackground(i, item.image_id)}
                      >
                        <img src={characterGalleryApi.smallUrl(item.image_id)} alt={item.caption || ''} />
                      </button>
                    ))}
                  </div>
                  {greetingBgs[i] && (
                    <button
                      type="button"
                      className={styles.bgGalleryClear}
                      onClick={() => assignBackground(i, null)}
                    >
                      <X size={10} />
                      Clear background
                    </button>
                  )}
                  {galleryItems.length === 0 && (
                    <span className={styles.bgGalleryEmpty}>No gallery images. Add images in the character editor.</span>
                  )}
                </div>
              )}
```

- [ ] **Step 5: Add CSS for the gallery picker**

In `frontend/src/components/modals/GreetingPickerModal.module.css`, append:

```css
.bgPickerBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--lumiverse-border);
  background: var(--lumiverse-fill-subtle);
  color: var(--lumiverse-text-muted);
  cursor: pointer;
  padding: 0;
  overflow: hidden;
  flex-shrink: 0;
}

.bgPickerBtn:hover {
  border-color: var(--lumiverse-primary);
  color: var(--lumiverse-primary);
}

.bgPickerThumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bgGalleryPicker {
  padding: 8px;
  border-top: 1px solid var(--lumiverse-border);
  background: var(--lumiverse-fill-subtle);
}

.bgGalleryGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
  gap: 6px;
}

.bgGalleryItem {
  aspect-ratio: 1;
  border-radius: 6px;
  border: 2px solid transparent;
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  background: none;
}

.bgGalleryItem img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bgGalleryItemActive {
  border-color: var(--lumiverse-primary);
}

.bgGalleryClear {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  background: rgba(255, 77, 77, 0.12);
  color: #ffb7b7;
  font-size: calc(11px * var(--lumiverse-font-scale, 1));
  cursor: pointer;
}

.bgGalleryEmpty {
  display: block;
  padding: 8px 0;
  color: var(--lumiverse-text-muted);
  font-size: calc(11px * var(--lumiverse-font-scale, 1));
  text-align: center;
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/modals/GreetingPickerModal.tsx frontend/src/components/modals/GreetingPickerModal.module.css
git commit -m "feat: add gallery image picker per greeting for background assignment"
```

---

### Task 6: Verify and test

- [ ] **Step 1: Build the frontend**

```bash
cd frontend && bun run build:checked
```

Expected: No TypeScript errors, build succeeds.

- [ ] **Step 2: Manual testing checklist**

1. Open WallpaperPanel — verify the "Use Character Avatar as Background" toggle and blur slider appear
2. Enable the toggle, open a chat with a character that has an avatar — verify the avatar appears as the chat background
3. Adjust the blur slider — verify blur applies to the wallpaper layer
4. Adjust the opacity slider — verify opacity still works alongside blur
5. Set a per-chat wallpaper — verify it overrides the character avatar background
6. Set a global wallpaper — verify it overrides the character avatar background
7. Clear all wallpapers, verify character avatar background reappears
8. Switch between chats with different characters — verify background changes
9. Open GreetingPickerModal on a character with gallery images — verify the image picker button appears on each greeting card
10. Assign a gallery image to a greeting — verify the background updates when switching to that greeting
11. Clear an assigned gallery image — verify it falls back to the avatar
12. Switch greetings — verify the background transitions smoothly

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during testing"
```
