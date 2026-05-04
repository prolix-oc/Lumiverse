# Regex Scripts

!!! warning "Permission required: `regex_scripts`"

Full CRUD access to the user's regex scripts plus a context-aware active-rule resolver. Use this for extensions that manage, analyze, or batch-edit find/replace rules — card-format compatibility shims, regex analytics, debug tooling, or anything that needs to mirror the resolution Lumiverse uses internally during prompt assembly, response baking, and display rendering.

## Usage

```ts
// List regex scripts (paginated)
const { data, total } = await spindle.regex_scripts.list({ limit: 50, offset: 0 })

// List only character-scoped rules attached to a specific character
const charRules = await spindle.regex_scripts.list({
  scope: 'character',
  scopeId: 'character-id',
})

// List only display-target rules
const displayRules = await spindle.regex_scripts.list({ target: 'display' })

// Get a single script
const script = await spindle.regex_scripts.get('script-id')
if (script) {
  spindle.log.info(`${script.name}: /${script.find_regex}/${script.flags}`)
}

// Create a script
const newScript = await spindle.regex_scripts.create({
  name: 'Strip OOC blocks',
  find_regex: '\\(\\(.*?\\)\\)',
  replace_string: '',
  flags: 'g',
  placement: ['ai_output'],
  target: 'display',
  scope: 'character',
  scope_id: 'character-id',
})

// Update a script
const updated = await spindle.regex_scripts.update(newScript.id, {
  disabled: true,
})

// Delete a script
const deleted = await spindle.regex_scripts.delete(newScript.id)

// Resolve the rules that would actually fire for a given context
const active = await spindle.regex_scripts.getActive({
  target: 'display',
  characterId: 'character-id',
  chatId: 'chat-id',
})
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: RegexScriptDTO[], total: number }>` | List scripts with strict scope filtering. Options: `{ scope?, scopeId?, target?, limit?, offset?, userId? }`. Defaults: limit 50, max 200. |
| `get(scriptId)` | `Promise<RegexScriptDTO \| null>` | Get a script by ID. Returns `null` if not found. |
| `create(input)` | `Promise<RegexScriptDTO>` | Create a new regex script. `name` and `find_regex` are required. |
| `update(scriptId, input)` | `Promise<RegexScriptDTO>` | Update a script. All fields are optional. Throws if the script is not found. |
| `delete(scriptId)` | `Promise<boolean>` | Delete a script. Returns `true` if deleted. |
| `getActive(options)` | `Promise<RegexScriptDTO[]>` | Resolve enabled scripts that would fire for a given target plus character/chat context. Merges global + character + chat scopes and orders them by scope tier then `sort_order`. |

## RegexScriptListOptionsDTO

| Field | Type | Description |
|---|---|---|
| `scope` | `"global" \| "character" \| "chat"` | Filter to a single scope. Omit to include all scopes. |
| `scopeId` | `string` | Required when `scope` is `character` or `chat` to narrow to a single entity. Ignored otherwise. |
| `target` | `"prompt" \| "response" \| "display"` | Filter by execution target. |
| `limit` | `number` | Page size. Default 50, max 200. |
| `offset` | `number` | Pagination offset. |
| `userId` | `string` | For operator-scoped extensions only. |

## RegexScriptActiveOptionsDTO

| Field | Type | Description |
|---|---|---|
| `target` | `"prompt" \| "response" \| "display"` | **Required.** The execution target to resolve for. |
| `characterId` | `string` | Include character-scoped rules attached to this character. |
| `chatId` | `string` | Include chat-scoped rules attached to this chat. |
| `userId` | `string` | For operator-scoped extensions only. |

`getActive` always includes global rules. Disabled rules are excluded.

## RegexScriptCreateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Display name shown in the regex panel. |
| `find_regex` | `string` | Yes | Pattern compiled with the JavaScript regex engine. Validated at create time. |
| `replace_string` | `string` | No | Replacement template. Supports `$1` / `$&` / `$<name>` capture references. Default `""`. |
| `flags` | `string` | No | Any subset of `gimsu`. Default `"gi"`. |
| `placement` | `RegexPlacementDTO[]` | No | Which message roles the rule applies to. Default `["ai_output"]`. |
| `scope` | `"global" \| "character" \| "chat"` | No | Default `"global"`. |
| `scope_id` | `string \| null` | No | Required when `scope` is non-global. |
| `target` | `"prompt" \| "response" \| "display"` | No | When the rule fires. Default `"response"`. |
| `min_depth` | `number \| null` | No | Lower bound on chat-history depth (0 = latest). |
| `max_depth` | `number \| null` | No | Upper bound on chat-history depth. |
| `trim_strings` | `string[]` | No | Additional substrings stripped from output after the regex pass. |
| `run_on_edit` | `boolean` | No | Re-run the rule when a message is edited. |
| `substitute_macros` | `"none" \| "raw" \| "escaped"` | No | How CBS / `{{...}}` macros inside the rule resolve. Default `"none"`. |
| `disabled` | `boolean` | No | Create as disabled. |
| `sort_order` | `number` | No | Lower values run earlier within the same scope tier. Default `0`. |
| `description` | `string` | No | Free-form note. |
| `folder` | `string` | No | Folder label shown in the regex panel. |
| `metadata` | `Record<string, unknown>` | No | Arbitrary metadata namespaced to your extension. |
| `script_id` | `string` | No | Stable identifier (normalized to lowercase + underscores) for cross-instance references. |

## RegexScriptUpdateDTO

Same fields as `RegexScriptCreateDTO`, all optional.

## RegexScriptDTO

```ts
{
  id: string
  name: string
  script_id: string             // stable, normalized identifier (lowercase, _-only)
  find_regex: string
  replace_string: string
  flags: string                 // any subset of "gimsu"
  placement: ("user_input" | "ai_output" | "world_info" | "reasoning")[]
  scope: "global" | "character" | "chat"
  scope_id: string | null       // character ID or chat ID when scoped
  target: "prompt" | "response" | "display"
  min_depth: number | null      // chat-history depth bound, or null
  max_depth: number | null
  trim_strings: string[]        // additional substrings stripped from output
  run_on_edit: boolean
  substitute_macros: "none" | "raw" | "escaped"
  disabled: boolean
  sort_order: number            // lower runs earlier within the same scope tier
  description: string
  folder: string
  metadata: Record<string, unknown>
  created_at: number            // unix epoch seconds
  updated_at: number
}
```

!!! note "Targets and where they fire"
    - **`prompt`** rules run during prompt assembly, against each message before it goes to the LLM. They do not modify stored content.
    - **`response`** rules run once after the LLM stream ends, against the full assistant message. The result is written back to chat storage.
    - **`display`** rules run per render in the frontend. They do not modify stored content.

!!! note "What `getActive` returns"
    `getActive` mirrors the resolution Lumiverse uses internally during a generation: only enabled rules, only rules whose `target` matches, and only rules whose scope applies to the supplied context. Use `list` instead when you need the raw, unfiltered view (including disabled rules) for management or analytics.

---

## Reacting to changes

Users can edit, reorder, enable, disable, and delete regex scripts at any time through the regex panel. Subscribe to the script lifecycle events to keep extension-side caches in sync.

```ts
spindle.on('REGEX_SCRIPT_CHANGED', (payload) => {
  // payload: { id: string, script: RegexScriptDTO }
  // fires on create, update, duplicate, reorder, and enable/disable.
})

spindle.on('REGEX_SCRIPT_DELETED', (payload) => {
  // payload: { id: string }
})
```

A common pattern: cache `spindle.regex_scripts.getActive(...)` per chat, invalidate the cache on either event, and re-fetch lazily on the next read.
