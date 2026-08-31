---
title: Productivity & Quick Toolbar
---

# Productivity & Quick Toolbar

The **Lumiverse Suite** extension adds a Productivity settings workspace for arranging common actions and tailoring several interface surfaces. When the suite is enabled, open **Settings → Productivity**. By default, this tab appears immediately after **Display & Layout**.

---

## Optional Surfaces & Navigation

The first settings card controls where the Productivity tab appears and whether several advanced controls are shown:

| Setting | What It Does |
|---------|--------------|
| **Productivity tab location** | Moves the Productivity tab to the top, bottom, or after another settings section. |
| **Embedding fallback profiles** | Shows primary and ordered fallback connections under [Embeddings](../settings/embeddings.md). |
| **Cortex secondary connections** | Shows independent extraction and summary fallback pickers in [Memory Cortex](../chatting/memory-cortex.md). |
| **Edit and Send** | Shows **Edit and Send** while editing a user-authored message. |
| **Drag to reorder toolbar icons** | Allows press-and-drag reordering directly on the live Quick Toolbar. |
| **Customize composer gear** | Shows the gear beside the composer action bar. |

Turning off one of these options hides its controls; it does not delete your saved connections or other underlying configuration.

---

## Quick Toolbar

The Quick Toolbar puts frequently used chat and navigation actions into a movable or docked strip. Use its master toggle in **Settings → Productivity → Quick Toolbar Settings** to show or hide it.

### Variants

| Variant | Behavior |
|---------|----------|
| **V1 Free** | A free-form toolbar that can float, rotate, resize, snap to an edge, and use horizontal or vertical orientation. |
| **V2 Adjacent** | A card-based toolbar designed for the chat dock. It uses fixed icon and label sizes rather than scaling the whole toolbar. |

### Placement

- **Floating** places the toolbar over the workspace. You can optionally keep the chat-top dock available for other controls.
- **Chat top dock** anchors it above the message list and gives it the remaining width beside native chat controls.

When docked, you can keep or hide the native **Select messages**, **Go to oldest message**, and **Browse messages** buttons. **Fill chat top bar width** stretches the toolbar through the available dock space.

### Appearance and Fit

The shared controls adjust icon size, label size, opacity, card dimensions, gaps, and backdrop color. Useful options include:

- **Opaque toolbar backdrop** prevents chat text from showing through the toolbar.
- **Auto-fit toolbar bounds to content** keeps its frame snug around the enabled actions.
- **Hide when overlaid** gets the toolbar out of the way when a full-screen surface opens.
- **Restore tab over full-screen dialogs** leaves a small edge handle that can bring the toolbar back.

V1 also exposes rotation, edge snapping, resize handles, orientation, and scale. V2 instead offers comfortable or compact card density, labels, and icon-only mode.

### Choosing and Reordering Actions

Under **Visible icons and order**:

1. Search for an action by name.
2. Toggle actions on or off.
3. Drag enabled actions into the desired order, or reorder them directly on the live toolbar when live reordering is enabled.
4. Use **Reset all toolbar settings** to restore the defaults.

The catalog includes native Lumiverse actions and compatible actions supplied by enabled extensions. If an extension is disabled or removed, its unavailable actions disappear without affecting the remaining order.

---

## Customizing the Composer

The action bar around the message composer can use the same action catalog as the Quick Toolbar.

1. Make sure **Customize composer gear** is enabled under **Optional surfaces & navigation**.
2. Open a chat and click the gear beside the composer actions.
3. Toggle icons to show or hide them.
4. Drag enabled icons into the order you want.
5. Click **Done**. Changes apply immediately.

Use **Reset icons** to restore the default composer layout. Composer layout is stored in the current browser, so another browser or device can have a different arrangement.

---

## Selecting Multiple Messages

The **Select messages** action enables bulk operations in the current chat. It is hidden from the composer by default, but you can add it through **Customize composer** or keep it in the chat-top dock.

While selection mode is active:

- Click or tap messages to select them.
- Use the selection bar to select or clear all messages.
- Hide or unhide the selected messages together.
- Delete the selected messages after confirmation.
- Click **Cancel** to leave selection mode.

!!! warning "Bulk deletion is permanent"
    Review the selection count before confirming. Deleted messages cannot be restored.

---

## Connections Picker

The Productivity workspace also configures the Lumiverse Suite connection picker. You can choose its visual variant, grid or list model layout, menu dimensions, density, favorites and recent sections, profile tags, and whether its chat launcher is visible.

Changing a picker layout does not change the active connection by itself. Your selected profile remains active until you choose another one.

---

## Troubleshooting

| Problem | What to Try |
|---------|-------------|
| The Productivity tab is missing | Enable **Lumiverse Suite** in the Extensions panel, then reload the frontend. |
| The composer gear is missing | Enable **Customize composer gear** in Productivity settings. |
| An action is missing from the toolbar | Search **Visible icons and order**, make sure it is enabled, and confirm that its contributing extension is running. |
| The toolbar covers chat text | Enable an opaque backdrop, use the chat-top dock, or turn on **Hide when overlaid**. |
| Embedding or Cortex fallback controls are missing | Re-enable the corresponding option under **Optional surfaces & navigation**. |
