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

## CharacterUpdateDTO

Same fields as `CharacterCreateDTO`, but all are optional (including `name`). Passing `world_book_ids` **replaces** the entire attached-book set; pass `[]` to detach all books, or omit the field to leave the existing attachments unchanged.

## World Book Attachments

`world_book_ids` exposes the array of world books attached directly to a character — the same list the built-in world book selector edits inside Lumiverse. The legacy single-id form is auto-migrated, so consumers can rely on the array form unconditionally.

This is the only structured field surfaced from the character's internal `extensions` blob; alternate fields, alternate avatars, expressions, and other extension-only state remain internal. Non-string and duplicate IDs in `world_book_ids` are silently filtered server-side.

Reading the attached world book *contents* still goes through the regular `spindle.world_books.*` API — `world_book_ids` is just the linkage layer.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, the user ID is resolved from the extension context. Characters are always scoped to a single user.
