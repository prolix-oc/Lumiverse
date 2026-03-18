# Personas

!!! warning "Permission required: `personas`"

Full CRUD access to the user's personas (identity profiles), plus active persona switching and attached world book retrieval.

## Usage

```ts
// List personas (paginated)
const { data, total } = await spindle.personas.list({ limit: 20, offset: 0 })

// Get a single persona
const persona = await spindle.personas.get('persona-id')
if (persona) {
  spindle.log.info(`Found: ${persona.name} (${persona.title})`)
}

// Get the default persona (is_default = true)
const defaultPersona = await spindle.personas.getDefault()

// Get the currently active persona
const active = await spindle.personas.getActive()
if (active) {
  spindle.log.info(`Active persona: ${active.name}`)
} else {
  spindle.log.info('No active persona')
}

// Create a persona (name is required)
const newPersona = await spindle.personas.create({
  name: 'Narrator',
  title: 'Omniscient storyteller',
  description: 'A neutral narrator who observes everything.',
  folder: 'Roleplay',
})

// Update a persona (all fields optional)
const updated = await spindle.personas.update(newPersona.id, {
  title: 'Omniscient but sarcastic storyteller',
  is_default: true,
})

// Switch the active persona
await spindle.personas.switchActive(newPersona.id)

// Deactivate (no active persona)
await spindle.personas.switchActive(null)

// Get the world book attached to a persona
const worldBook = await spindle.personas.getWorldBook(newPersona.id)
if (worldBook) {
  spindle.log.info(`Attached world book: ${worldBook.name}`)
}

// Delete a persona
const deleted = await spindle.personas.delete(newPersona.id)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: PersonaDTO[], total: number }>` | List personas. Options: `{ limit?, offset? }`. Defaults: limit 50, max 200. |
| `get(personaId)` | `Promise<PersonaDTO \| null>` | Get a persona by ID. Returns `null` if not found. |
| `getDefault()` | `Promise<PersonaDTO \| null>` | Get the user's default persona (`is_default = true`). Returns `null` if none set. |
| `getActive()` | `Promise<PersonaDTO \| null>` | Get the user's currently active persona. Returns `null` if none is active. |
| `create(input)` | `Promise<PersonaDTO>` | Create a new persona. `name` is required. |
| `update(personaId, input)` | `Promise<PersonaDTO>` | Update a persona. All fields are optional. |
| `delete(personaId)` | `Promise<boolean>` | Delete a persona. Returns `true` if deleted. |
| `switchActive(personaId)` | `Promise<void>` | Switch the active persona. Pass `null` to deactivate. |
| `getWorldBook(personaId)` | `Promise<WorldBookDTO \| null>` | Get the world book attached to a persona. Returns `null` if none attached. |

## PersonaDTO

```ts
{
  id: string
  name: string
  title: string                         // short tagline
  description: string
  image_id: string | null               // avatar via Images API
  attached_world_book_id: string | null // linked world book
  folder: string                        // organizational grouping
  is_default: boolean
  metadata: Record<string, unknown>
  created_at: number                    // unix epoch seconds
  updated_at: number
}
```

## PersonaCreateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Persona name |
| `title` | `string` | No | Short description/tagline |
| `description` | `string` | No | Full persona description |
| `folder` | `string` | No | Organizational folder label |
| `is_default` | `boolean` | No | Set as the default persona (clears previous default) |
| `attached_world_book_id` | `string` | No | World book ID to attach |
| `metadata` | `Record<string, unknown>` | No | Custom metadata |

## PersonaUpdateDTO

Same fields as `PersonaCreateDTO`, but all are optional (including `name`).

## Active Persona

`getActive()` reads the `activePersonaId` setting that the frontend persists when the user selects a persona. `switchActive()` writes to the same setting and emits a `SETTINGS_UPDATED` event, so the frontend updates immediately.

```ts
// Contextual persona switching
const active = await spindle.personas.getActive()
if (active?.folder === 'Roleplay') {
  spindle.log.info('User is in roleplay mode')
}

// Switch and notify
await spindle.personas.switchActive('new-persona-id')
spindle.toast.success('Persona switched!')
```

## Attached World Books

Each persona can have one world book attached via `attached_world_book_id`. The `getWorldBook()` method is a convenience that reads the persona, checks the attachment, and returns the full `WorldBookDTO` — all in a single call. Only `personas` permission is required (not `world_books`).

```ts
const persona = await spindle.personas.getActive()
if (persona) {
  const wb = await spindle.personas.getWorldBook(persona.id)
  if (wb) {
    spindle.log.info(`Persona "${persona.name}" uses world book "${wb.name}"`)
  }
}
```

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, the user ID is resolved from the extension context. Personas are always scoped to a single user.
