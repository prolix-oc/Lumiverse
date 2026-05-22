# Characters

!!! warning "Permission required: `characters`"

Full CRUD access to the user's character cards. Use this for extensions that manage, analyze, or batch-edit characters.

## Usage

```ts
// List characters (paginated)
const { data, total } = await spindle.characters.list({ limit: 20, offset: 0 })

// Get a single character
const char = await spindle.characters.get('character-id')
if (char) {
  spindle.log.info(`Found: ${char.name}`)
}

// Create a character (name is required)
const newChar = await spindle.characters.create({
  name: 'Alice',
  description: 'A curious adventurer.',
  personality: 'Brave, curious, kind.',
  first_mes: 'Hello! Ready for an adventure?',
  tags: ['adventure', 'fantasy'],
})

// Update a character (all fields optional)
const updated = await spindle.characters.update(newChar.id, {
  personality: 'Brave, curious, kind, and a bit reckless.',
  tags: ['adventure', 'fantasy', 'action'],
})

// Attach world books to a character (replaces the current set)
await spindle.characters.update(newChar.id, {
  world_book_ids: ['lore-book-id', 'glossary-book-id'],
})

// Detach all world books
await spindle.characters.update(newChar.id, { world_book_ids: [] })

// Store extension-specific data (shallow-merged into existing extensions)
await spindle.characters.update(newChar.id, {
  extensions: {
    'my-extension': { questStage: 3, affinity: 72 },
  },
})

// Read extension data back
const char = await spindle.characters.get(newChar.id)
const myData = char?.extensions['my-extension']

// Delete a character
const deleted = await spindle.characters.delete(newChar.id)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: CharacterDTO[], total: number }>` | List characters. Options: `{ limit?, offset? }`. Defaults: limit 50, max 200. |
| `get(characterId)` | `Promise<CharacterDTO \| null>` | Get a character by ID. Returns `null` if not found. |
| `create(input)` | `Promise<CharacterDTO>` | Create a new character. `name` is required. |
| `update(characterId, input)` | `Promise<CharacterDTO>` | Update a character. All fields are optional. |
| `delete(characterId)` | `Promise<boolean>` | Delete a character. Returns `true` if deleted. |

## CharacterDTO

```ts
{
  id: string
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  tags: string[]
  alternate_greetings: string[]
  creator: string
  image_id: string | null
  /** IDs of world books attached directly to this character. */
  world_book_ids: string[]
  /** Raw extensions object. Extensions should namespace their keys. */
  extensions: Record<string, any>
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

## CharacterCreateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Character name |
| `description` | `string` | No | Character description |
| `personality` | `string` | No | Personality summary |
| `scenario` | `string` | No | Scenario/setting |
| `first_mes` | `string` | No | First message (greeting) |
| `mes_example` | `string` | No | Example dialogue |
| `creator_notes` | `string` | No | Creator notes |
| `system_prompt` | `string` | No | System prompt override |
| `post_history_instructions` | `string` | No | Post-history instructions |
| `tags` | `string[]` | No | Tags for organization |
| `alternate_greetings` | `string[]` | No | Alternative first messages |
| `creator` | `string` | No | Creator name |
| `world_book_ids` | `string[]` | No | World books to attach to the character on creation |
| `extensions` | `Record<string, any>` | No | Initial extension data to store on the character |

## CharacterUpdateDTO

Same fields as `CharacterCreateDTO`, but all are optional (including `name`).

- Passing `world_book_ids` **replaces** the entire attached-book set; pass `[]` to detach all books, or omit the field to leave the existing attachments unchanged.
- Passing `extensions` **shallow-merges** the provided object into the character's existing extensions. Extension-provided keys overwrite existing ones; omitting a key leaves it untouched. Pass an empty object to make no changes, or omit the field entirely.

## Extension Data

The full `extensions` blob is exposed on `CharacterDTO` so extensions can read and write their own namespaced keys. This is the same object that stores Lumiverse-internal extension state (world books, alternate fields, expressions, etc.).

**Best practices:**

- **Namespace your keys.** Use your extension's identifier or a unique prefix to avoid collisions with other extensions or future Lumiverse features.
- **Keep values JSON-serializable.** The object is stored as JSON in the database.
- **Shallow-merge on update.** When you pass `extensions` to `update()`, only the top-level keys you provide are overwritten. Deeply nested objects are replaced wholesale at the top level, not recursively merged.

```ts
// Good: namespaced key
await spindle.characters.update(char.id, {
  extensions: { 'com.example.quest-mod': { stage: 2 } },
})

// Risky: generic key might collide
await spindle.characters.update(char.id, {
  extensions: { metadata: { stage: 2 } },
})
```

## World Book Attachments

`world_book_ids` exposes the array of world books attached directly to a character — the same list the built-in world book selector edits inside Lumiverse. The legacy single-id form is auto-migrated, so consumers can rely on the array form unconditionally.

Non-string and duplicate IDs in `world_book_ids` are silently filtered server-side.

Reading the attached world book *contents* still goes through the regular `spindle.world_books.*` API — `world_book_ids` is just the linkage layer.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, the user ID is resolved from the extension context. Characters are always scoped to a single user.
