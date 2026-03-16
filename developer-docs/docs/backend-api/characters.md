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

## CharacterUpdateDTO

Same fields as `CharacterCreateDTO`, but all are optional (including `name`).

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, the user ID is resolved from the extension context. Characters are always scoped to a single user.
