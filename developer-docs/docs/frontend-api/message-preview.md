# Message previews

Mount Lumiverse's native message renderer in an extension-owned UI root to preview a stored swipe or a source range. This includes display preprocessing, the active chat's display resolver, display regex, Markdown, and sanitized HTML islands. The preview follows host formatting and theme settings.

```ts
const supported = ctx.components.listHostSurfaces().some(surface => surface.id === 'message_preview')
if (supported) {
  const preview = ctx.components.mountHostSurface(container, 'message_preview', {
    chatId,
    messageId,
    swipeIndex: 1,
    start: islandStart,
    end: islandEnd,
  })
  // Replace the complete props object when selecting another source.
  preview.update({ chatId, messageId, swipeIndex: 0 })
  // Destroy when the containing preview closes.
  preview.destroy()
}
```

`chatId` and `messageId` are required and must identify a message loaded in the active chat. `swipeIndex` defaults to the message's active swipe. `start` defaults to zero; `end` defaults to the source length. Offsets use JavaScript UTF-16 string indices and describe a half-open range `[start, end)`. Choose complete resolver envelopes or HTML islands when previewing a fragment: display rules run against the selected source range, so rules anchored to a complete message can produce different output for a fragment.

The caller cannot provide arbitrary HTML or another chat's content. The host reads its current canonical source. If the loaded message has a light swipe projection, the host fetches that message's complete swipe set without changing chat state. Pending requests are ignored after navigation, source changes, or unmount. Missing messages, stale/out-of-bounds ranges, or chat navigation display an unavailable notice. If the message changes while a preview is open, its current source is used; saving an extension's edited result still needs its own revision checks.

The surface has no additional permission requirement beyond mounting within the caller's live UI root. It uses the existing host-component ownership and teardown rules, including update/destroy and extension unload. Tag interceptors are not delivered, shared message widgets are not mounted, regex send/append/effects actions do not activate, and long-message expansion does not alter the original chat's state. Disclosure controls, code copying, image viewing, and the normal display-resolution callbacks retain their existing presentation behavior. This is a display preview, not a sandbox for executing scripts or a guarantee that a third-party display resolver is side-effect-free.

Feature-detect this surface before mounting it on older hosts. Its props are JSON-only and use the existing `mountHostSurface` interface; no private frontend imports are needed.
