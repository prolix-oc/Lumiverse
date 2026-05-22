# Presets

!!! warning "Permission required: `presets`"

Full CRUD access to the user's generation presets and their prompt blocks. Use this for extensions that manage Loom presets, inspect prompt assembly structure, or batch-edit blocks and categories.

## Shape

Presets are stored as one record with several JSON fields:

- `parameters` stores sampler/custom-body settings and other provider parameters.
- `prompt_order` stores the ordered prompt block list.
- `prompts` stores prompt behavior, completion settings, and advanced prompt settings.
- `metadata` stores Loom metadata such as description, source, model profiles, default status, and prompt variable values.

Prompt categories are not separate records. A category is a structural prompt block where `marker === 'category'`. Its children are the following non-category prompt blocks until the next category block. Use `spindle.presets.categories.list()` when you want this grouping precomputed by the host.

## Usage

```ts
// List presets (paginated)
const { data, total } = await spindle.presets.list({ limit: 20, offset: 0 })

// Get a single preset
const preset = await spindle.presets.get('preset-id')
if (preset) {
  spindle.log.info(`Found preset: ${preset.name}`)
}

// Create a minimal Loom-style preset
const newPreset = await spindle.presets.create({
  name: 'My Extension Preset',
  provider: 'loom',
  engine: 'classic',
  parameters: {},
  prompt_order: [],
  prompts: {},
  metadata: { description: 'Created by my extension' },
})

// Update the preset metadata
const updated = await spindle.presets.update(newPreset.id, {
  metadata: {
    ...newPreset.metadata,
    description: 'Updated description',
  },
})

// Delete the preset
const deleted = await spindle.presets.delete(newPreset.id)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: UserPresetDTO[], total: number }>` | List presets. Options: `{ limit?, offset? }`. Defaults: limit 50, max 200. |
| `get(presetId)` | `Promise<UserPresetDTO \| null>` | Get a preset by ID. Returns `null` if not found. |
| `create(input)` | `Promise<UserPresetDTO>` | Create a new preset. `name` and `provider` are required. |
| `update(presetId, input)` | `Promise<UserPresetDTO>` | Update a preset. All fields are optional. |
| `delete(presetId)` | `Promise<boolean>` | Delete a preset. Returns `true` if deleted. |

## UserPresetDTO

```ts
{
  id: string
  name: string
  provider: string
  engine: string
  parameters: Record<string, unknown>
  prompt_order: PromptBlockDTO[]
  prompts: Record<string, unknown>
  metadata: Record<string, unknown>
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

## UserPresetCreateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Preset name |
| `provider` | `string` | Yes | Preset provider, usually `loom` for native Lumiverse presets |
| `engine` | `string` | No | Engine identifier. Defaults to `classic` |
| `parameters` | `Record<string, unknown>` | No | Provider parameters and Loom sampler/custom-body settings |
| `prompt_order` | `PromptBlockDTO[]` | No | Ordered prompt blocks, including structural category markers |
| `prompts` | `Record<string, unknown>` | No | Prompt behavior, completion settings, and advanced settings |
| `metadata` | `Record<string, unknown>` | No | Preset metadata and extension-specific data |

## UserPresetUpdateDTO

Same fields as `UserPresetCreateDTO`, but all are optional, including `name` and `provider`.

!!! note "Prompt variable cleanup"
    When `prompt_order` or `metadata` is updated, Lumiverse prunes stale `metadata.promptVariables` entries that no longer correspond to a variable definition on a block. This matches the built-in preset editor behavior.

---

## Prompt Blocks

Prompt blocks are managed through `spindle.presets.blocks`. Block operations update the parent preset's `prompt_order` and trigger the normal preset update flow.

### Block Usage

```ts
// List blocks in order
const blocks = await spindle.presets.blocks.list('preset-id')

// Get a single block
const block = await spindle.presets.blocks.get('preset-id', 'block-id')

// Append a new system block
const newBlock = await spindle.presets.blocks.create('preset-id', {
  name: 'Style Guide',
  content: 'Write with concise, vivid prose.',
  role: 'system',
  position: 'pre_history',
  enabled: true,
})

// Insert a category marker at the start of the preset
const category = await spindle.presets.blocks.create(
  'preset-id',
  {
    name: 'Tone',
    marker: 'category',
    categoryMode: 'radio',
    content: '',
  },
  { index: 0 },
)

// Update a block
const updatedBlock = await spindle.presets.blocks.update('preset-id', newBlock.id, {
  enabled: false,
})

// Delete a block
const blockDeleted = await spindle.presets.blocks.delete('preset-id', newBlock.id)
```

### Block Methods

| Method | Returns | Description |
|---|---|---|
| `list(presetId)` | `Promise<PromptBlockDTO[]>` | Return the preset's ordered prompt blocks. |
| `get(presetId, blockId)` | `Promise<PromptBlockDTO \| null>` | Get a block by ID. Returns `null` if not found. |
| `create(presetId, input, options?)` | `Promise<PromptBlockDTO>` | Create a prompt block. `options.index` inserts at a specific zero-based position; omitted appends. |
| `update(presetId, blockId, input)` | `Promise<PromptBlockDTO>` | Update a block. All fields except `id` are optional. |
| `delete(presetId, blockId)` | `Promise<boolean>` | Delete a block. Returns `true` if deleted. |

### PromptBlockDTO

```ts
{
  id: string
  name: string
  content: string
  role: 'system' | 'user' | 'assistant' | 'user_append' | 'assistant_append'
  enabled: boolean
  position: 'pre_history' | 'post_history' | 'in_history'
  depth: number
  marker: string | null
  isLocked: boolean
  color: string | null
  injectionTrigger: string[]
  group: string | null
  categoryMode?: 'radio' | 'checkbox' | null
  variables?: PromptVariableDefDTO[]
}
```

### PromptBlockCreateDTO / PromptBlockUpdateDTO

`PromptBlockCreateDTO` accepts any subset of `PromptBlockDTO`. Missing fields are defaulted by the host. `PromptBlockUpdateDTO` accepts any subset except `id`; the existing block ID is preserved.

Common fields:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Human-readable block label |
| `content` | `string` | Prompt text for normal blocks; usually empty for marker blocks |
| `role` | `'system' \| 'user' \| 'assistant' \| 'user_append' \| 'assistant_append'` | Message role or append injection tag |
| `enabled` | `boolean` | Whether the block participates in prompt assembly |
| `position` | `'pre_history' \| 'post_history' \| 'in_history'` | Where the block injects relative to chat history |
| `depth` | `number` | Depth when `position` is `in_history` |
| `marker` | `string \| null` | Structural marker. Use `'category'` for category headers |
| `categoryMode` | `'radio' \| 'checkbox' \| null` | Category selection mode; meaningful only on category marker blocks |
| `variables` | `PromptVariableDefDTO[]` | Prompt variable definitions for this block |

---

## Categories

Use `spindle.presets.categories.list()` to get category grouping without reimplementing Lumiverse's grouping rules.

```ts
const groups = await spindle.presets.categories.list('preset-id')

for (const group of groups) {
  const label = group.categoryBlock?.name ?? 'Uncategorized'
  spindle.log.info(`${label}: ${group.children.length} blocks`)
}
```

### Category Methods

| Method | Returns | Description |
|---|---|---|
| `list(presetId)` | `Promise<PromptBlockCategoryGroupDTO[]>` | Return category groups derived from the preset's ordered blocks. |

### PromptBlockCategoryGroupDTO

```ts
{
  categoryBlock: PromptBlockDTO | null
  children: PromptBlockDTO[]
}
```

The first group can have `categoryBlock: null` when normal blocks appear before the first category marker.

## User Scoping

For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `userId` as the final argument or inside the options object where supported.

```ts
// Operator-scoped extension targeting a specific user
const { data } = await spindle.presets.list({ userId: 'user-id' })
const block = await spindle.presets.blocks.create(
  'preset-id',
  { name: 'Operator Note', content: '...' },
  { userId: 'user-id' },
)
```

## Best Practices

- Treat `parameters`, `prompts`, and `metadata` as owned by the preset editor unless you intentionally manage those fields.
- Namespace extension-specific metadata under your extension identifier to avoid collisions.
- Prefer block CRUD for localized prompt edits instead of rewriting the entire `prompt_order` array.
- Use `categories.list()` for UI or analytics; create/update/delete category headers through `blocks.*`.
- Check `spindle.permissions.has('presets')` before showing preset-management UI.
