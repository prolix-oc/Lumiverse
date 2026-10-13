# Regex Scripts

!!! warning "Permission required: `regex_scripts`"

Read access to the user's regex scripts, CRUD access to scripts created by the calling extension, plus a context-aware active-rule resolver. Use this for extensions that manage their own find/replace rules, analyze existing rules, or mirror the resolution Lumiverse uses internally during prompt assembly, response baking, and display rendering.

Extension-created scripts are attributed by the host. Ownership, not the preset link, decides what an extension may change: it cannot update or delete legacy/unattributed scripts, another extension's scripts, or rows it does not own. A script it created stays writable after it is bound to a preset, and deleting that preset deletes the script with it. Protected scripts remain visible through `list`, `get`, and `getActive` and continue to execute normally.

A refused mutation rejects with `Regex script is not an unbound script owned by this extension`. The wording predates the preset-link change and is kept verbatim because callers match on it; the rule it enforces is ownership only.

Extensions whose purpose is to edit the user's complete regex library may also request the privileged `regex_scripts_unrestricted` permission. It is additive: both permissions must be granted. With it, `update` and `delete` may target legacy, card-bound, preset-bound, and other-extension-owned scripts. The host still protects ownership, binding, and trusted folder-version attribution from reassignment.

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
  spindle.log.info(`${script.name}: /${script.find_regex}/${script.flags} (writable: ${script.can_mutate})`)
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

// Optionally identify a versioned folder installed by this extension.
// Use the same folder and folder_version for every script in the bundle.
const bundledScript = await spindle.regex_scripts.create({
  name: 'Extension display cleanup',
  find_regex: '<extension-note>[\\s\\S]*?<\\/extension-note>',
  replace_string: '',
  target: 'display',
  folder: 'My Extension',
  folder_version: '2.4.0',
})

// Create a display action associated with
// <button data-regex-action="continue-scene">...</button>
const interactiveScript = await spindle.regex_scripts.create({
  name: 'Interactive scene',
  find_regex: '<scene>([\\s\\S]*?)<\\/scene>',
  replace_string: '<button data-regex-action="continue-scene">Continue $1</button>',
  flags: 'g',
  placement: ['ai_output'],
  target: 'display',
  actions: [{
    id: 'continue-scene',
    type: 'send',
    multi_select: false,
    cost: '1',
    limit: '3',
    title: 'Continue $1',
    subtitle: '',
    content: 'Continue with $1.',
  }],
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
| `update(scriptId, input)` | `Promise<RegexScriptDTO>` | Update a script created by this extension, preset-bound or not, or any script when `regex_scripts_unrestricted` is also granted. All fields are optional. Throws for protected scripts. |
| `delete(scriptId)` | `Promise<boolean>` | Delete a script created by this extension, preset-bound or not, or any script when `regex_scripts_unrestricted` is also granted. Throws for protected scripts; returns `true` if deleted. |
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
| `actions` | `RegexActionDTO[]` | No | Associative actions for elements in display replacement HTML. Default `[]`. |
| `flags` | `string` | No | Any subset of `dgimsuvy` (full JS regex flag set: `d` hasIndices, `g` global, `i` ignore-case, `m` multiline, `s` dotAll, `u` unicode, `v` unicodeSets, `y` sticky). No duplicates. Default `"gi"`. |
| `placement` | `RegexPlacementDTO[]` | No | Which message roles the rule applies to. Default `["ai_output"]`. |
| `scope` | `"global" \| "character" \| "chat"` | No | Default `"global"`. |
| `scope_id` | `string \| null` | No | Required when `scope` is non-global. |
| `target` | `"prompt" \| "response" \| "display"` | No | When the rule fires. Default `"response"`. |
| `min_depth` | `number \| null` | No | Lower bound on chat-history depth (0 = latest). |
| `max_depth` | `number \| null` | No | Upper bound on chat-history depth. |
| `trim_strings` | `string[]` | No | Additional substrings stripped from output after the regex pass. |
| `run_on_edit` | `boolean` | No | Re-run the rule when a message is edited. |
| `substitute_macros` | `"none" \| "find" \| "raw" \| "escaped" \| "after"` | No | How CBS / `{{...}}` macros inside the rule resolve. Use `"find"` to resolve only `find_regex`. Prefer `"after"` when `replace_string` contains macros. Default `"none"`. |
| `disabled` | `boolean` | No | Create as disabled. |
| `sort_order` | `number` | No | Lower values run earlier within the same scope tier. Default `0`. |
| `description` | `string` | No | Free-form note. |
| `folder` | `string` | No | Folder label shown in the regex panel. |
| `folder_version` | `string \| null` | No | Optional version label for an extension-installed folder. Requires a non-empty `folder`; maximum 100 characters. Omit it for the normal folder display with no version chip. |
| `metadata` | `Record<string, unknown>` | No | Host behavior fields described below, plus namespaced extension metadata. |
| `script_id` | `string` | No | Stable identifier (normalized to lowercase + underscores) for cross-instance references. |
| `preset_id` | `string \| null` | No | Bind the created script to one of the calling user's presets. Create-only: `update` never re-points or clears the link. An unknown or foreign preset ID is rejected with `Linked preset not found`; a non-string value is rejected with `preset_id must be a string or null`; `null` and `""` leave the script unbound. The link is a lifecycle binding — the host deletes the script when that preset is deleted, and preset activation does not change the script's `disabled` state, so the extension keeps control of its own rule's enablement. |

## RegexScriptUpdateDTO

Same fields as `RegexScriptCreateDTO`, all optional, except that `preset_id` is create-only: `update` strips it from extension input, so an owner re-points a script by deleting and recreating it. The field stays in the published `RegexScriptUpdateDTO` type as excluded, so passing it is a type error instead of a silent no-op.

`folder_version` is script-level, host-managed attribution used by the regex panel. When creating a versioned bundle, provide the same `folder` and `folder_version` on every script in that folder. Lumiverse renders the unique attributed versions as Spindle-colored chips beside the folder name.

- Omitting `folder_version` on create produces a normal folder with no version chip.
- Omitting it on update preserves the script's current folder version.
- Passing `null` or an empty string on update clears the script's folder version.
- Clearing `folder` also removes the attribution when the extension performs the update.
- A version supplied without a non-empty `folder` is accepted but not stored or rendered.

The host records the calling extension identifier with the version and does not trust a lookalike value placed directly in `metadata`. Scripts not owned by the calling extension cannot acquire this attribution through the Spindle API.

## RegexActionDTO

```ts
{
  id: string
  type: "send" | "append"
  multi_select: boolean
  cost: string
  limit: string
  title: string
  subtitle: string
  content: string
}
```

The action `id` associates with `data-regex-action="id"` (preferred) or `id="id"` in replacement HTML. Actions only activate for enabled scripts with the `display` target. `title`, `subtitle`, `content`, `cost`, and `limit` support native replacement captures such as `$1`, `$&`, and `$<name>`.

A single-select `send` action creates a visible user turn and starts generation. A single-select `append` action waits for the next user turn and attaches hidden prompt content. When `multi_select` is true, `cost` is the option's positive numeric cost and `limit` is the block's positive total-cost bound. The resolved block limit is the lowest positive limit among its options.

Multi-select options toggle in a provisional client-side pool. They can be removed until Send begins, at which point all selected options are atomically claimed and their visible `send` and hidden `append` modifiers are consumed together. A single-select `send` action is also a Send signal and joins the same atomic batch as its staged modifiers. Single-select `append` actions remain non-triggering. Claims are persisted on the source message, making committed options one-shot across rerenders and clients.

## RegexScriptDTO

```ts
{
  id: string
  can_mutate: boolean          // calling extension may update/delete this row, preset-bound or not
  name: string
  script_id: string             // stable, normalized identifier (lowercase, _-only)
  find_regex: string
  replace_string: string
  actions: RegexActionDTO[]
  flags: string                 // any subset of "dgimsuvy" (full JS regex flag set)
  placement: ("user_input" | "ai_output" | "world_info" | "reasoning" | "memory")[]
  scope: "global" | "character" | "chat"
  scope_id: string | null       // character ID or chat ID when scoped
  target: "prompt" | "response" | "display"
  min_depth: number | null      // chat-history depth bound, or null
  max_depth: number | null
  trim_strings: string[]        // additional substrings stripped from output
  run_on_edit: boolean
  substitute_macros: "none" | "find" | "raw" | "escaped" | "after"
  disabled: boolean
  sort_order: number            // lower runs earlier within the same scope tier
  description: string
  folder: string
  preset_id: string | null      // preset this row is bound to for the delete cascade; null when unbound
  folder_version?: string | null // host-validated Spindle folder version; older hosts may omit it
  metadata: Record<string, unknown>
  created_at: number            // unix epoch seconds
  updated_at: number
}
```

### Macro substitution modes

Every mode except `"none"` resolves macros in `find_regex`. The selected mode also controls whether and when macros in `replace_string` resolve.

- **`"none"`** — no macro evaluation. `replace_string` is substituted as-is by the regex engine; capture refs (`$1`, `$&`, `$<name>`) work, but any `{{...}}` survives literal in the output. Use when you don't need macros.
- **`"find"`**: evaluate macros in `find_regex` only. `replace_string` remains unchanged.
- **`"raw"`** — substitute captures into `replace_string` first, then evaluate the result **per match**. Macros can reference captures (e.g. `{{lower::$1}}`). Cost: N `evaluate()` calls for N matches.
- **`"escaped"`** — evaluate `replace_string` **once before** substitution, then double-escape `$` so capture refs do not fire. Cost: one `evaluate()` call per render. Cannot use captures (`$1` is dead).
- **`"after"`** — substitute captures literally with native `String.replace`, then run one `evaluate()` over the **entire result body**. Cost: one `evaluate()` call per render. Macros can reference captures (they appear as plain text by the time evaluation runs).

**Prefer `"after"` whenever your `replace_string` contains macros.** It collapses N evaluation calls to one (matching `"escaped"` performance) while keeping capture support (matching `"raw"` capability). It also matches how single-pass parsers in upstream regex pipelines already work, so ported rules behave the same.

The one observable difference from `"raw"`: stateful macros (`{{counter::*}}`, `{{addvar::*::1}}{{getvar::*}}` patterns, etc.) accumulate left-to-right across matches in `"after"` mode rather than running in isolation per match. A counter that emitted `1, 1, 1, 1` under `"raw"` emits `1, 2, 3, 4` under `"after"`. The `"after"` behavior is almost always what you actually want; stay on `"raw"` only if you specifically need per-match isolation.

### Preset prompt activation metadata (native API)

Preset-bound scripts can store `metadata.prompt_activation`:

```ts
{
  source: "user_input" | "ai_output",
  lifetime: "latest" | "chat",
  mappings: [{
    capture: "mode",        // "0" = full match, "1"–"99" = numbered group, or a named group
    value: ["combat", "fight"], // any exact trimmed match; also accepts a single literal string
    block_ids: ["rules", "format"], // IDs in this script's linked preset
    enabled: true
  }]
}
```

Creation and update validate the preset's ownership and each target ID. Activation is unavailable on unbound scripts, including ordinary extension-owned scripts. Unlinking and standalone duplication remove this configuration. Preset exports preserve it and preset imports bind it to the imported preset; block IDs must be preserved or remapped by the importer.

Mapping `value` accepts a literal string or an array of 1–64 nonblank strings, each at most 1,000 characters. Alternatives use OR semantics with trimming and the script's `i` flag; duplicates apply the row only once per capture. Legacy strings remain literal, including commas and newlines. The editor parses comma/newline-separated input (with CSV-style quoting) into this string-or-array representation; API clients should submit arrays for alternatives, not a comma-separated string. The same representation is used by preview, generation, and preset import/export. Captured text is still compared exactly; neither capture contents nor value entries are interpreted as regex patterns or split into words.

Activation runs before prompt variables/rendering, independent of replacement Placement/Target. All mapped targets start disabled, regardless of profile defaults, and valid captures apply ordered runtime overrides. Category IDs expand to their category and children; radio exclusivity remains enforced. There are at most 64 mappings, 128 target IDs per row, 1000 matches per source, and 500,000 characters per source; regex execution uses the existing worker timeout.

Find patterns accept only these bounded substitutions: `{{char}}`, `{{user}}`, `{{getchatvar::key}}`, and `{{presetvar::block-id::variable-id}}`. Arguments must be explicit, static IDs/keys. Preset references are checked against the linked preset on save. The latter uses typed, profile-over-preset-over-default values from the identified schema, even when its block is disabled. It does not read local/global runtime variables, render blocks, call extension interceptors, or recursively evaluate returned text. Every substituted value becomes a noncapturing literal atom, preserving capture numbering and preventing regex injection. Templates are forbidden inside character classes or immediately after an escape. Limits: 10,000 source-pattern characters, 32 inputs, 1,024 characters per value, 100,000 resolved-pattern characters. Missing, blank, non-scalar, and oversized inputs fail the entire rule closed with a diagnostic; numeric zero and boolean false remain valid.

Assembly takes one pre-render input snapshot, resolving each rule once before history replay. Response processing reuses that snapshot. Display replacements use an owned server-side persisted snapshot, bypassing unrestricted find-macro evaluation and display caches for these templates; ordinary replacement macro behavior is unchanged. This bounded find behavior is independent of `substitute_macros` and available only on preset-linked activation scripts. Current inputs reinterpret old matches on each assembly; no event-time activation state is persisted.

`latest` evaluates only the most recent visible message of the configured source; `chat` replays selected visible history. Message order, scoped script order, match order, then mapping order resolve conflicts. Existing min/max depth bounds apply. Assistant matches must finish at the true end of a successfully completed message, allowing trailing whitespace. Their effects become available to subsequent generations. The combined message is checked after Continue. Stopped output is ineligible; source text removed by response replacements is preserved per swipe and invalidated when the saved message is edited.

`POST /api/v1/regex-scripts/test-activation` accepts `{ preset_id, find_regex, flags, content, prompt_activation, chat_id?, character_id?, persona_id?, connection_id? }` and returns `{ matches: [{ mapping_index, value, index }], resolved_find_regex?: string, error?: string }`. Context IDs must belong to the authenticated user. Preview reads saved state using the same resolver and coercion as assembly, applies matching profile values (otherwise the linked preset's defaults), and performs no writes, including no cleanup of stale profile bindings. Unsaved preset edits are excluded. Without a chat, chat keys are unavailable. Activation diagnostics are also available internally as `AssemblyResult.macroEnv.extra.promptActivation` with `states` and `errors`.

### Match behavior metadata

The regex editor stores these optional host fields in `metadata`:

- `match_actions`: any of `"move_top"`, `"move_bottom"`, and `"repeat_back"`.
- `repeat_position`: optional repeat placement override. Supported values are `"start"`, `"end"`, `"start_nl"`, and `"end_nl"`.
- `repeat_raw_match`: when `true`, `repeat_back` carries the original matched text without applying `replace_string`. Defaults to `false`.

Move actions remove the first match and place its capture-expanded replacement at the start or end of the current value. Repeat runs only when the current value has no match. It copies the first match from the nearest earlier message with the same role, falling back to the greeting. When the current value matches, normal replacement behavior still applies.

These behaviors are shared by prompt, response, and display execution. Frontend display execution stays local and does not add a backend round trip.

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
