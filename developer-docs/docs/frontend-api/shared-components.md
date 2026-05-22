# Shared Components

Lumiverse's first-party React components — model pickers, form atoms, searchable selects, pagination, collapsible sections — are exposed to extensions via `ctx.components.*`. The host renders the real component into a DOM node you control. You never need to depend on React, ship the component CSS, or replicate the look in plain HTML.

Mounted components automatically inherit the active Lumiverse theme (accent color, glass mode, dark/light, density), so they visually match the rest of the host UI without any styling work on your part.

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  const tab = ctx.ui.registerDrawerTab({ id: 'demo', title: 'Demo' })

  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:12px'
  tab.root.appendChild(wrap)

  const labelEl = document.createElement('div')
  wrap.appendChild(labelEl)

  const modelSlot = document.createElement('div')
  wrap.appendChild(modelSlot)

  const enabledSlot = document.createElement('div')
  wrap.appendChild(enabledSlot)

  // Mount a model picker bound to the user's active LLM connection
  const model = ctx.components.mountModelCombobox(modelSlot, {
    value: '',
    connection: { kind: 'llm' },
    appearance: 'standard',
    onChange: (m) => { labelEl.textContent = `Selected: ${m}` },
  })

  // Mount a switch
  const toggle = ctx.components.mountSwitch(enabledSlot, {
    checked: true,
    onChange: (on) => ctx.sendToBackend({ type: 'set_enabled', value: on }),
  })

  return () => {
    model.destroy()
    toggle.destroy()
    tab.destroy()
  }
}
```

## How mounting works

Every `mountX(target, options)` call:

1. **Resolves the target** — pass either an `HTMLElement` or a CSS selector string scoped to your extension's DOM.
2. **Renders the real component** into that element.
3. **Returns a handle** with `update()`, `getValue()`, `destroy()`, and component-specific helpers.

The handle is the only thing you need to keep alive. Mounted components are auto-destroyed when your extension is disabled or unloaded — but you should still call `destroy()` yourself when you reuse the target for something else, to avoid leaking memory.

### Shared handle shape

Every handle implements `SpindleMountedComponent<TOptions>`:

| Method / Property | Returns | Description |
|---|---|---|
| `componentId` | `string` | Host-assigned ID, unique per extension. Useful in logs. |
| `element` | `HTMLElement` | The target element the component was mounted into. |
| `update(patch)` | `void` | Merge a partial of the original options into the live component. Pass only the fields you want to change. |
| `destroy()` | `void` | Unmount the React tree and release host resources. The target element is left in place. |

Form components add `getValue()` so you can read the current value at any time:

```ts
const handle = ctx.components.mountTextInput(target, { value: 'hello' })
console.log(handle.getValue())     // → 'hello'
handle.update({ value: 'world' })  // programmatic value change
handle.update({ disabled: true })  // any partial option works
```

### Controlled vs. auto-controlled

Components are **auto-controlled** by the host. You supply an initial value and an `onChange` callback — the host owns internal state across user interactions. To force the value from your code, call `handle.update({ value })`. To read the current value, call `handle.getValue()`.

You do **not** need to mirror state into your own variables and call `update()` on every change — that's already happening inside the host.

## Component catalog

| Helper | What it mounts |
|---|---|
| `mountTextInput` | Single-line text field |
| `mountTextArea` | Multi-line text editor |
| `mountNumericInput` | Validated number input with optional empty state |
| `mountNumberStepper` | Number input with +/− buttons |
| `mountRangeSlider` | Touch-friendly slider with optional label, hint, and formatted value display |
| `mountCheckbox` | Standard checkbox with optional label and hint |
| `mountSwitch` | Toggle switch |
| `mountSelect` | Searchable single-select dropdown |
| `mountMultiSelect` | Searchable multi-select dropdown |
| `mountModelCombobox` | LLM/image/TTS model picker, connection-aware |
| `mountFolderDropdown` | Folder picker with inline "create folder" affordance |
| `mountBadge` | Inline status/label badge |
| `mountSpinner` | Loading spinner |
| `mountCollapsibleSection` | Titled, expandable container — see [body slot](#collapsible-sections-with-host-managed-chrome) |
| `mountPagination` | Page navigation with per-page selector |
| `mountCloseButton` | Themed X button |

## Text inputs

```ts
const note = ctx.components.mountTextArea(target, {
  value: '',
  rows: 6,
  placeholder: 'Notes…',
  onChange: (text) => ctx.sendToBackend({ type: 'save_note', text }),
})

// Save on a hotkey from elsewhere in your extension
function flush() {
  ctx.sendToBackend({ type: 'save_note', text: note.getValue() })
}

// Programmatically focus
note.focus()
```

### SpindleTextInputOptions / SpindleTextAreaOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `value` | `string` | `""` | Initial value |
| `onChange` | `(v: string) => void` | — | Fired on every user change |
| `placeholder` | `string` | — | Placeholder text |
| `autoFocus` | `boolean` | `false` | Focus on mount (text input only) |
| `rows` | `number` | `4` | Visible rows (text area only) |
| `disabled` | `boolean` | `false` | Disable user interaction |
| `className` | `string` | — | Additional CSS class |
| `ariaLabel` | `string` | — | Accessible label |

Both handles expose `getValue()`, `focus()`, and `blur()` in addition to the shared methods.

## Numeric inputs

```ts
const temperature = ctx.components.mountNumberStepper(target, {
  value: 0.7,
  min: 0,
  max: 2,
  step: 0.1,
  onChange: (v) => ctx.sendToBackend({ type: 'set_temp', value: v }),
})
```

### SpindleNumericInputOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `value` | `number \| null` | `null` | Initial value. `null` means empty. |
| `onChange` | `(v: number \| null) => void` | — | Fired on every user change |
| `allowEmpty` | `boolean` | `false` | Allow `null` as a valid value |
| `integer` | `boolean` | `false` | Restrict to integers |
| `min` / `max` | `number` | — | Bounds |
| `step` | `number` | — | Native step size |
| `placeholder` | `string` | — | Placeholder text |
| `disabled` | `boolean` | `false` | Disable user interaction |

`SpindleNumberStepperOptions` accepts the same fields except `integer`, and uses `step: 1` by default.

### Range slider

A touch-first slider with horizontal drag. Vertical scroll passes through the slider on mobile (the host does JS direction detection and only claims horizontal gestures), and mid-drag interruptions don't kill the gesture — the slider commits the last live value if the touch is cancelled after movement. The built-in header tracks the live drag value in real time; `onCommit` only fires once when the gesture ends.

```ts
const opacity = ctx.components.mountRangeSlider(target, {
  label: 'Opacity',
  min: 0,
  max: 100,
  step: 5,
  integer: true,
  value: 35,
  format: { suffix: '%' },
  onCommit: (v) => ctx.sendToBackend({ type: 'set_opacity', value: v / 100 }),
})

// Programmatically jump to a value
opacity.update({ value: 80 })

// Read the latest committed value
const current = opacity.getValue()
```

Omit `label` to render the bare track without a header — useful when you want to lay out your own label/value display alongside other content. In that case, use `onDragValue` to mirror the live value into your own UI:

```ts
const valueLabel = document.createElement('span')
container.appendChild(valueLabel)

ctx.components.mountRangeSlider(track, {
  min: 0, max: 1, step: 0.05, value: 0.5,
  onDragValue: (v) => { valueLabel.textContent = v === null ? '0.50' : v.toFixed(2) },
  onCommit: (v) => { valueLabel.textContent = v.toFixed(2); ctx.sendToBackend({ type: 'set_strength', value: v }) },
})
```

#### SpindleRangeSliderOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `min` | `number` | — | **Required.** Inclusive lower bound. |
| `max` | `number` | — | **Required.** Inclusive upper bound. |
| `value` | `number` | `min` | Initial committed value. |
| `step` | `number` | `1` | Snap increment. |
| `integer` | `boolean` | `false` | Round to integers regardless of `step` formatting. |
| `onCommit` | `(v: number) => void` | — | Fired once when a drag ends or the user taps the track. Not fired during the drag. |
| `onDragValue` | `(v: number \| null) => void` | — | Fired with the live value during a drag, and with `null` if the gesture ends without committing. |
| `label` | `string` | — | If set, renders a header above the track with the label and live value. |
| `hint` | `string` | — | Helper text under the header. Ignored if `label` is omitted. |
| `format` | `SpindleRangeSliderFormat` | — | Declarative formatting for the value in the header (see below). Ignored if `label` is omitted. |
| `disabled` | `boolean` | `false` | Dim the track and ignore input. |
| `className` | `string` | — | Additional CSS class merged onto the track area. |

#### SpindleRangeSliderFormat

| Field | Type | Description |
|---|---|---|
| `decimals` | `number` | Number of decimal places to show. Defaults to whatever `step` implies (or `0` for `integer` sliders). |
| `prefix` | `string` | Prepended before the value, e.g. `"$"`. |
| `suffix` | `string` | Appended after the value, e.g. `"%"` or `"ms"`. |

#### SpindleRangeSliderHandle

In addition to the [shared handle methods](#shared-handle-shape):

| Method | Returns | Description |
|---|---|---|
| `getValue()` | `number` | The current committed value. |

## Boolean inputs

```ts
const showAdvanced = ctx.components.mountCheckbox(target, {
  checked: false,
  label: 'Show advanced controls',
  hint: 'Reveal sampler and routing options',
  onChange: (on) => detailsRow.style.display = on ? 'block' : 'none',
})
```

### SpindleCheckboxOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `checked` | `boolean` | `false` | Initial state |
| `onChange` | `(checked: boolean) => void` | — | Fired on every toggle |
| `label` | `string` | — | Label rendered next to the checkbox |
| `hint` | `string` | — | Helper text rendered under the label |
| `disabled` | `boolean` | `false` | Disable user interaction |

### SpindleSwitchOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `checked` | `boolean` | `false` | Initial state |
| `onChange` | `(checked: boolean) => void` | — | Fired on every toggle |
| `size` | `'sm' \| 'md'` | `'md'` | Visual size |
| `disabled` | `boolean` | `false` | Disable user interaction |
| `ariaLabel` | `string` | — | Accessible label |

## Selects

`mountSelect` (single) and `mountMultiSelect` share the same option surface except for value/onChange types. Both support search, grouped options, themed dropdowns, leading cells (icons / avatars / swatches), and portal rendering.

```ts
const picker = ctx.components.mountSelect(target, {
  value: '',
  placeholder: 'Pick a tone…',
  searchPlaceholder: 'Search tones…',
  onChange: (v) => ctx.sendToBackend({ type: 'set_tone', value: v }),
  options: [
    { value: 'casual', label: 'Casual', group: 'Conversational' },
    { value: 'witty', label: 'Witty',   group: 'Conversational' },
    { value: 'formal', label: 'Formal', group: 'Professional' },
    { value: 'dry',    label: 'Dry',    group: 'Professional' },
  ],
})
```

### SpindleSelectOption

| Field | Type | Default | Description |
|---|---|---|---|
| `value` | `string` | *required* | Stable value emitted to `onChange` |
| `label` | `string` | *required* | Display label |
| `sublabel` | `string` | — | Secondary text rendered beneath the label |
| `group` | `string` | — | Group key. Options sharing a group cluster under a shared header. |
| `leading` | `SpindleSelectOptionLeading` | — | Leading-cell content (avatar / icon / swatch / initial). See below. |
| `disabled` | `boolean` | `false` | Render as disabled |

### SpindleSelectOptionsBase (shared by single & multi)

| Option | Type | Default | Description |
|---|---|---|---|
| `options` | `SpindleSelectOption[]` | `[]` | Available choices |
| `placeholder` | `string` | — | Placeholder text when no value is selected |
| `searchPlaceholder` | `string` | — | Placeholder for the search input |
| `searchThreshold` | `number` | `8` | Minimum option count before the search input is shown |
| `emptyMessage` | `string` | — | Message when no options were supplied |
| `noResultsMessage` | `string` | — | Message when the search query has no matches |
| `triggerLabel` | `string` | — | Force a trigger label (e.g. `"+ Add"`), ignoring current selection |
| `triggerIcon` | `SpindleSelectOptionLeading` | — | Custom icon shown on the trigger |
| `triggerClassName` | `string` | — | Additional CSS class on the trigger button |
| `ariaLabel` | `string` | — | Accessible label for the trigger |
| `portal` | `boolean` | `true` | Render the dropdown into `document.body` so it escapes `overflow:hidden` ancestors |
| `align` | `'left' \| 'right'` | `'left'` | Dropdown horizontal alignment relative to the trigger |
| `maxHeight` | `number` | — | Maximum dropdown height in CSS pixels |
| `minWidth` | `number` | — | Minimum dropdown width in CSS pixels |
| `disabled` | `boolean` | `false` | Disable interaction |
| `className` | `string` | — | Additional CSS class on the wrapper |

Single-select also accepts:

| Option | Type | Default | Description |
|---|---|---|---|
| `clearable` | `boolean` | `false` | Show a pinned "None" option at the top of the dropdown that emits `onChange("")` |
| `clearLabel` | `string` | `"None"` | Label for the clear option |

Both handles expose `getValue()`, `open()`, and `close()` in addition to the shared methods.

### Leading cells: avatars, icons, swatches, initials

`SpindleSelectOptionLeading` is a declarative union for the small slot rendered before each option label (and on the trigger when an option is selected). Use it for persona avatars, provider brand marks, category swatches, or letter bubbles. Extensions describe what they want — no React, no `<img>` tags, no styling required.

=== "Image with initial fallback"

    The same pattern used by Lumiverse's own persona picker. If the image is missing or fails to load, the host falls back to the supplied initial bubble.

    ```ts
    leading: {
      type: 'image',
      src: persona.avatarUrl,
      rounded: true,
      fallback: {
        text: persona.name.charAt(0).toUpperCase(),
        background: 'var(--lumiverse-fill-subtle)',
      },
    }
    ```

=== "Inline SVG icon"

    Best for brand marks or chevron-like glyphs. The SVG is host-sanitized before insertion.

    ```ts
    leading: {
      type: 'icon-svg',
      svg: '<svg viewBox="0 0 16 16">...</svg>',
      color: 'var(--lumiverse-accent)',
    }
    ```

=== "Icon URL"

    Same as image, but without the avatar-style rounded fallback semantics.

    ```ts
    leading: { type: 'icon-url', url: '/icons/openai.png' }
    ```

=== "Color swatch"

    Small filled circle for category tags and palette pickers.

    ```ts
    leading: { type: 'swatch', color: '#7e57c2' }
    ```

=== "Initial bubble"

    Plain text bubble — works well with single characters or short labels.

    ```ts
    leading: {
      type: 'initial',
      text: 'A',
      background: '#3a3a3a',
      color: '#fff',
    }
    ```

#### Full example: persona picker

```ts
ctx.components.mountSelect(target, {
  value: currentPersonaId,
  triggerLabel: currentPersonaId ? undefined : '+ Choose persona',
  searchPlaceholder: 'Search personas…',
  noResultsMessage: 'No personas match your search.',
  clearable: true,
  clearLabel: 'Unassign',
  options: personas.map((p) => ({
    value: p.id,
    label: p.name,
    sublabel: p.title,
    leading: p.avatarUrl
      ? {
          type: 'image',
          src: p.avatarUrl,
          fallback: { text: p.name.charAt(0).toUpperCase() },
        }
      : { type: 'initial', text: p.name.charAt(0).toUpperCase() },
  })),
  onChange: (id) => ctx.sendToBackend({ type: 'set_persona', personaId: id || null }),
})
```

## Model combobox

`mountModelCombobox` is the same picker Lumiverse uses for selecting LLM, image-gen, and TTS models. It has two operating modes.

### Connection-bound mode (recommended)

Supply a `connection` reference and the host wires up everything for you — the model list, the refresh affordance, the loading spinner, and live updates when the user switches their active connection.

```ts
ctx.components.mountModelCombobox(target, {
  value: '',
  // Follow the user's currently-active LLM connection
  connection: { kind: 'llm' },
  appearance: 'standard',
  onChange: (model) => ctx.sendToBackend({ type: 'set_model', model }),
})
```

To pin to a specific connection instead of the active one:

```ts
connection: { kind: 'image', id: profileId }
```

Supported `kind` values:

| Kind | Source | Active connection follows |
|---|---|---|
| `'llm'` | LLM connection profiles | `activeProfileId` |
| `'image'` | Image-gen connection profiles | `activeImageGenConnectionId` |
| `'tts'` | TTS connection profiles + their voice catalogs | `voiceSettings.ttsConnectionId` |
| `'embedding'` | *Not yet supported in connection-bound mode — use manual mode.* | — |

The host fetches via Lumiverse's authenticated API on your behalf, so you don't need `cors_proxy` or any backend wiring for the model list. Call `handle.refresh()` to force a re-fetch (e.g. after the user adds a new model in your extension's settings).

### Manual mode

Supply `models`, `loading`, and `onRefresh` yourself when you maintain the catalog. Useful for OpenRouter-style listings, custom proxies, or filtered subsets.

```ts
let models: string[] = []
let loading = false

const picker = ctx.components.mountModelCombobox(target, {
  value: '',
  models,
  loading,
  onRefresh: () => {
    loading = true
    picker.update({ loading: true })
    fetchModelsFromBackend().then((next) => {
      loading = false
      picker.update({ models: next, loading: false })
    })
  },
  onChange: (m) => ctx.sendToBackend({ type: 'set_model', model: m }),
})
```

If both `connection` and `models` are supplied, `connection` wins and the manual fields are ignored.

### SpindleModelComboboxOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `value` | `string` | `""` | Currently entered model ID |
| `onChange` | `(v: string) => void` | — | Fired on every change |
| `connection` | `{ kind, id? }` | — | Bind to a host-managed connection. See above. |
| `models` | `string[]` | `[]` | Manual mode: explicit model list |
| `modelLabels` | `Record<string, string>` | `{}` | Manual mode: ID → human label |
| `loading` | `boolean` | `false` | Manual mode: show the spinner in the refresh affordance |
| `onRefresh` | `() => void` | — | Manual mode: invoked when the user clicks refresh |
| `autoRefreshOnFocus` | `boolean` | `false` | Auto-refresh once the first time the input gains focus |
| `refreshKey` | `string` | — | Opaque key — when it changes, re-arms `autoRefreshOnFocus` |
| `appearance` | `'compact' \| 'standard' \| 'editor'` | `'compact'` | Visual density to match the surrounding form |
| `placeholder` | `string` | `"gpt-4o"` | Placeholder text |
| `emptyMessage` | `string` | — | Message when the list is empty |
| `loadingMessage` | `string` | `"Loading models..."` | Message shown in the dropdown while loading |
| `browseHint` | `string` | — | Optional hint shown beneath the input |
| `disabled` | `boolean` | `false` | Disable interaction |

The handle exposes `refresh()` in addition to `getValue()` and the shared methods.

## Folder dropdown

```ts
ctx.components.mountFolderDropdown(target, {
  folders: ['Personal', 'Work', 'Drafts'],
  value: 'Personal',
  placeholder: 'No folder',
  onChange: (folder) => ctx.sendToBackend({ type: 'move_to', folder }),
  onCreateFolder: (name) => ctx.sendToBackend({ type: 'create_folder', name }),
})
```

### SpindleFolderDropdownOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `folders` | `string[]` | `[]` | Available folder names |
| `value` | `string` | `""` | Currently selected folder |
| `onChange` | `(folder: string) => void` | — | Fired when the user picks a folder |
| `onCreateFolder` | `(name: string) => void` | — | Fired when the user creates a new folder inline |
| `placeholder` | `string` | — | Placeholder shown when no folder is selected |
| `disabled` | `boolean` | `false` | Disable interaction |

## Collapsible sections (with host-managed chrome)

Unlike other components, `mountCollapsibleSection` gives you back a **`body` element** — the host renders the header/chevron chrome, and you fully own the body contents. Append your own elements to `handle.body` exactly as you would to a `tab.root` or `panel.root`.

```ts
const section = ctx.components.mountCollapsibleSection(target, {
  title: 'Advanced',
  iconSvg: '<svg>...</svg>',
  badge: '3',
  defaultExpanded: false,
  onToggle: (open) => console.log('section is now', open ? 'open' : 'closed'),
})

// Build whatever you want into the body
section.body.innerHTML = '<p>Body content owned by the extension.</p>'

// Imperative controls
section.expand()
section.collapse()
section.toggle()
console.log(section.isExpanded())
```

### SpindleCollapsibleSectionOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | *required* | Header text |
| `iconSvg` | `string` | — | Inline SVG icon shown next to the title |
| `iconUrl` | `string` | — | Icon image URL. Mutually exclusive with `iconSvg`. |
| `badge` | `string \| number` | — | Optional badge text rendered next to the title |
| `defaultExpanded` | `boolean` | `true` | Initial expanded state |
| `onToggle` | `(expanded: boolean) => void` | — | Fired whenever the user toggles the section |

### SpindleCollapsibleSectionHandle

Adds to the shared shape:

| Method / Property | Returns | Description |
|---|---|---|
| `body` | `HTMLElement` | Container the extension owns. Append your own child elements here. |
| `isExpanded()` | `boolean` | Current expanded state |
| `expand()` | `void` | Open the section |
| `collapse()` | `void` | Close the section |
| `toggle()` | `void` | Flip the section |

## Display utilities

```ts
const status = ctx.components.mountBadge(target, { text: 'Beta', color: 'warning', size: 'pill' })
status.update({ color: 'success', text: 'Ready' })

const spinner = ctx.components.mountSpinner(target, { size: 16 })
spinner.destroy()

const closeBtn = ctx.components.mountCloseButton(target, {
  onClick: () => panel.collapse(),
  size: 'sm',
  variant: 'subtle',
})
```

### SpindleBadgeOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `text` | `string` | `""` | Badge text |
| `color` | `'neutral' \| 'primary' \| 'success' \| 'warning' \| 'danger' \| 'info'` | `'neutral'` | Accent color |
| `size` | `'sm' \| 'md' \| 'pill'` | `'md'` | Visual size |

### SpindleSpinnerOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `size` | `number` | `16` | Diameter in CSS pixels |
| `fast` | `boolean` | `false` | Use the faster rotation variant |

### SpindleCloseButtonOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `onClick` | `() => void` | — | Click handler |
| `size` | `'sm' \| 'md'` | `'md'` | Visual size |
| `variant` | `'subtle' \| 'solid'` | `'subtle'` | Visual variant |
| `position` | `'static' \| 'absolute'` | `'static'` | Positioning behavior |
| `iconSize` | `number` | — | Icon size override in CSS pixels |

## Pagination

```ts
let page = 1

const pager = ctx.components.mountPagination(target, {
  currentPage: page,
  totalPages: 12,
  totalItems: 234,
  perPage: 20,
  perPageOptions: [10, 20, 50],
  onPageChange: (p) => {
    page = p
    pager.update({ currentPage: p })
    ctx.sendToBackend({ type: 'list_page', page: p })
  },
  onPerPageChange: (n) => ctx.sendToBackend({ type: 'set_page_size', size: n }),
})
```

### SpindlePaginationOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `currentPage` | `number` | *required* | Current page index (1-based) |
| `totalPages` | `number` | *required* | Total page count |
| `onPageChange` | `(p: number) => void` | *required* | Fired when the user clicks a page |
| `perPage` | `number` | — | Current per-page selection (omit to hide the selector) |
| `perPageOptions` | `number[]` | — | Page-size choices |
| `onPerPageChange` | `(n: number) => void` | — | Fired when the user changes per-page |
| `totalItems` | `number` | — | Total item count for the "Showing X–Y of N" summary |

Pagination is fully controlled — call `pager.update({ currentPage: next })` after each navigation to keep the UI in sync.

## Lifecycle & cleanup

| Event | What the host does |
|---|---|
| You call `handle.destroy()` | The React tree is unmounted. The target element remains in place. |
| You replace the target's contents (e.g. `el.innerHTML = ''`) | **Don't.** Destroy the handle first. Replacing the DOM under React's feet leaks memory. |
| Your extension is disabled / unloaded | All mounted components are destroyed automatically as part of cleanup, alongside drawer tabs, dock panels, and other placements. |
| The extension reloads (dev/manifest change) | New mounts are created against fresh targets. Stale handles from the previous load are unmounted by the host. |

!!! tip "Pairing with placement APIs"
    Shared components are designed to live inside extension-owned containers — drawer tab roots, dock panel roots, app mount roots, modal bodies, float widget roots. Build your container with `ctx.dom.createElement()`, append it to the placement root, then mount a shared component into it.

## Theming & styling

You generally do not need to style mounted components. They consume the same CSS variables as Lumiverse's own UI:

- Accent colors via `--lumiverse-accent` and friends
- Surface/border/text colors via `--lumiverse-fill-subtle`, `--lumiverse-border`, `--lumiverse-text`, `--lumiverse-text-dim`
- Radius via `--lumiverse-radius`

If you need to tweak spacing or alignment around a mounted component, do it on the **wrapper element you own** (the target you passed to `mount*`). Avoid trying to override component internals with `!important` rules — those internals are not part of the public contract and can change.

## Capacity limits

Mounting shared components has no per-extension cap — they are scoped to whatever container you already own (a drawer tab, a dock panel, a modal body, an app mount), and those placements already enforce their own [capacity limits](ui-placement.md#capacity-limits).
