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

## Normalized Agent runtime configuration

Agent runtime configuration is not generic preset metadata. The authenticated
preset service stores one normalized V2 projection in
`preset_agent_configs`, `preset_agent_profiles`,
`preset_agent_connection_slots`, and `preset_agent_slot_bindings`.
`Preset.agent_config` is the safe projection of that preset-owned data and
`Preset.agent_config_review` reports review/repair state and items; it does not
by itself decide executability. The durable chat override lives separately in
`chat_agent_mode_overrides` and is resolved by the runtime decision service.
Runtime executability additionally requires enabled/allowed mode, host
ceilings, concrete capabilities, revisions/readiness, and kill-switch health.
The runtime reads this projection through `agent-config-portability.service.ts`;
it does not select a connection from `metadata` or from a
`connectionProfileId` field.

The closed authored shape is `AgentConfigV2`:

```ts
{
  version: 2,
  agentsEnabled: boolean,
  allowedModes: ['response'] | ['agentic', 'response'] | ['response', 'agentic'],
  defaultMode: 'response' | 'agentic',
  maxInvocations: number,
  maxToolCalls: number,
  mainToolIds: CoreAgentToolId[],
  mainLoreScope: AgentLoreScope,
  profiles: [{
    id: string,
    name: string,
    systemPrompt: string,
    connectionRef:
      | { kind: 'inherit_main' }
      | { kind: 'slot', slotId: string },
    toolIds: CoreAgentToolId[],
    workspaceCapabilities: AgentChildWorkspaceCapabilityV1[],
    loreScope: AgentLoreScope,
    allowMainDelegation: boolean,
    failurePolicy: 'required' | 'optional',
    streamActivity: boolean,
    maxOutputTokens: number,
    timeoutMs: number,
  }],
  connectionSlots: [{
    id: string,
    label: string,
    requiredCapabilities: [
      'generation' | 'streaming' | 'tool_calling' |
      'native_tool_continuation' | 'tools_disabled_finalization',
    ][],
  }],
  cognitionPolicy?: AgentCognitionPolicyV1,
  taskPolicy?: AgentTaskPolicyV1,
  workspacePolicy?: { retention: 'turn_terminal' | 'chat_lifetime', sharing: 'root_only' | 'view_only' },
  runtimePolicy?: AgentRuntimePolicyV1,
}
```

`profiles[].workspaceCapabilities` is an optional, closed
`AgentChildWorkspaceCapabilityV1[]` child-profile capability ceiling. The
normalized projection emits values in this canonical sorted order:

```ts
[
  'read_section',
  'read_page',
  'update_assigned_progress',
  'submit_child_result',
]
```

Values must be unique and already in this order. Unknown, duplicate, or
out-of-order values are rejected or quarantined; they are never silently
reordered or widened.

These values are profile-level ceilings for child frames, not standalone
runtime grants. An effective grant is the intersection of the profile ceiling,
root policy, and the immutable capability set admitted on that exact frame.
Pre-scheduled intrinsic children have no durable provider-dispatch grant and
therefore receive no workspace capabilities; provider-delegated children may
receive the four operations above, subject to host admission, phase, and budget
limits.
Operations outside this vocabulary—including `create_task`,
`submit_root_result`, `accept_submission`, `record_finding`,
`record_decision`, `record_question`, `attach_artifact`, and
`propose_publication`—remain root/host authority and cannot be granted through
a child profile. Profile-authored grants cannot
widen root capabilities, completion authority, or publication authority.


### Canonical Loom authoring and assembly

The executable Loom authoring record is
`AgentConfigV2.runtimePolicy`, not preset metadata or the legacy
`cognitionPolicy`. Its current shape is:

```ts
runtimePolicy: {
  version: 1,
  authority: 'loom',
  scope: 'preset',
  defaultMode: 'response' | 'agentic',
  loomPolicy: {
    version: 1,
    workPolicy: LoomPolicyEntryV1[],
    workspaceUsage: LoomPolicyEntryV1[],
    completionCriteria: LoomPolicyEntryV1[],
    renderPolicy: LoomPolicyEntryV1[],
  } | null,
  phases: readonly AgentCustomPhaseV1[],
}
```

Each `LoomPolicyEntryV1` is closed:

```ts
{
  version: 1,
  id: string,
  source: {
    kind: 'loom_block',
    blockId: string,
    presetRevision: number,
    blockRevision: number,
    promptOrder: number,
  },
  destination: 'root_work' | 'completion_handoff' | 'render',
  checkpoint: 'ASSEMBLE' | 'WORK' | 'PREPARE_COMMIT' | 'RENDER',
  required: boolean,
  visibility: 'work_only',
  condition?: CognitionPredicateV1,
}
```

Routing is fixed: `workPolicy` and `workspaceUsage` feed `root_work` at `WORK` (root **WORK** / **WORK**); `completionCriteria` feeds `completion_handoff` at `PREPARE_COMMIT`; and `renderPolicy` feeds `render` at `RENDER` (tools-disabled **RENDER** / **RENDER**). The host freezes each Loom source revision before assembly. Conditions are typed, evaluate fail-closed at their owning checkpoint against that checkpoint’s immutable snapshot, and remain fixed for that checkpoint.

The **Phased Instructions** editor is the single WORK/Agentic-only authoring surface for these fixed Loom policy buckets, bounded custom runtime phases, and typed conditions. Loom owns only existing prompt blocks plus Phased Instructions; it does not create a second context authority. `runtimePolicy.phases` is bounded and current-phase-only: later phase instructions are not materialized early. Each phase can carry explicit `childInstructionSubsets`; a child receives only its named admitted subset, never the root phase instructions or another child’s subset.

No live `cognitionPolicy`, metadata alias, or extension callback can replace the canonical Loom record.

World Books (the native World Info system) and Databanks remain outside this policy and revision contract. World Books own native lore activation, placement, attachment, editing, and access. Databanks own attached documents, attachment, editing, access, automatic semantic retrieval, and explicit `#slug` retrieval. Their live native objects remain authoritative. Loom never copies that content, stores an external revision, pins it, or repairs it. [Context Filters](../../../user-docs/docs/presets/context-filters.md) and unrelated native Loom content [packs](../../../user-docs/docs/packs/index.md) remain supported outside Loom.

The retired **Context Pack**, **Context Library**, and **Progressive Context** surfaces are not supported and do not participate in this policy or revision contract.

The authenticated assembly surface is explicit (`RESPONSE` or `WORK`) and is
carried by the frozen snapshot and `AssemblyPlanV1`; it is never inferred from
the presence of policy entries. Response assembly omits every
`visibility: 'work_only'` entry. Owner inspection receives typed
`LoomPromptInspectionV1` items and a `responseOmission` record instead of
silently presenting WORK material as Response content. This omission does not
disable established Response assembly, including native World Info and
Databank behavior.

The inspection source is exact: Loom entries retain `blockId`, `presetRevision`, `blockRevision`, `promptOrder`, optional typed condition, checkpoint result, route, and inclusion outcome. Unified owner inspection combines this Loom record with prompt evidence for role, destination/order, source identity and content hashes when recorded, every destination-level deduplication overlap and reason, omissions, custom-phase and explicit child-subset receipts, accepted WORK-to-RENDER crossings, and tools/delegation. An unavailable evidence layer is marked unavailable and is never inferred. The `inspection` and `responseOmission` wire names are stable and must not be replaced by a latest revision or compatibility alias. Ordinary Response preserves the conversation and native World Book/Databank assembly while omitting only WORK/Agentic-only Loom material.

Prompt evidence preserves the same occurrence authority as Loom: cognition uses the frozen Loom source's `blockId`, `promptOrder`, and `blockRevision`, while non-cognition evidence uses the canonical assembly provenance coordinate. Owner inspection joins roles only by `sourceId + promptOrder + sourceRevision` when the complete prompt section is available; it never selects the first record sharing an ID/revision or correlates from a truncated prefix.

`GET /api/v1/presets/:id/agent-config`, the shared-draft save, and the
portable runtime envelope preserve `runtimePolicy.loomPolicy` verbatim
through their revision fences. The normalized authenticated projection is
the only executable authority.

---


`allowedModes` is ordered, unique, always contains `response`, and
`defaultMode` must be allowed. A profile refers to an authored preset-scoped
slot or explicitly inherits the root connection. A slot binding is the only
place that stores a local `connection_id`, and it carries a binding revision
and `ready | review_required | repair_required` state.
Capabilities and host ceilings are checked again when the runtime resolves the
concrete connection; authored values cannot raise process limits.

`AgentConfigV2` in the normalized tables is the only executable authority.
Ordinary preset create/update DTOs accept only exact top-level
`agent_config` V2. They reject V1 and scrub all runtime-looking metadata keys,
including `metadata.agentConfig`, review aliases, portable aliases, and
runtime-envelope aliases, without interpreting them. Explicit database
migration, user-data archive, preset-file, and LumiHub import boundaries may
parse legacy V1 exactly once, normalize it, and remove the legacy carriers.
Normal preset reads project only normalized tables; no metadata alias is
executable.

Version-1 migration is deliberately Response-only:

- absent config, marker-only metadata, or V1 `enabled: false` becomes
  `agentsEnabled: false`, `allowedModes: ['response']`,
  `defaultMode: 'response'`, and `ready` state;
- a structurally valid V1 `enabled: true` preserves authored
  profiles/tools/limits but remains Response-only; no V1 row enables Agentic;
- a local direct profile binding becomes deterministic slot
  `profile/<profileId>`; a `null` binding becomes `inherit_main`;
- malformed legacy config becomes inert `repair_required` with a bounded
  repair reason; an unresolved foreign/stale binding becomes inert
  `review_required` until it is mapped and acknowledged.

Loom/LumiHub imports have two explicit paths. If the exported object (or its
embedded `preset`) contains `agentRuntime`, the installer strictly parses the
`PortablePresetRuntimeEnvelopeV1` before writing and atomically imports the
preset, normalized config, and task templates. This complete-runtime path
preserves authored policy but imports it disabled, Response-only, and
review-required; it cannot grant activation or local bindings. If no envelope
is present, the explicit legacy import path strictly parses
`metadata.agentConfig`, migrates it to a portable V2 payload, and sends it
through the same transactional importer. Legacy authored settings remain
preserved but disabled, Response-only, and review-required. In both paths
metadata is not executable runtime authority; normalized authenticated config
routes remain the runtime source.

Same-account duplicate copies the preset, normalized config, authorized slot
bindings, regex companions, task templates, and review acknowledgements.
Foreign import never copies local bindings. Neither path copies or owns native
World Info or Databank content; those systems retain their existing attachment
and live-resolution behavior.

### Authenticated config and portability routes

These routes are mounted under `/api/v1/presets` and are the server authority
for normalized config:

| Method | Endpoint | Contract |
|---|---|---|
| `GET` | `/:id/agent-config` | Returns the editor object directly (not a `{ preset, editor }` wrapper): `presetId`, `presetRevision`, `configRevision`, `config: AgentConfigV2`, `review`, `slotBindings`, `taskTemplates`, `hostCeilings`, and `reviewAcknowledgements`. Missing/foreign presets return `404`. |
| `PUT` | `/:id/agent-config` | Atomically saves the closed body keys `config`, `slotBindings`, `taskTemplates`, `reviewAcknowledgements`, `promptOrder`, `expectedPresetRevision`, and `expectedConfigRevision`; unknown or malformed bodies return `400`, while a missing revision precondition returns `428`. |
| `GET` | `/:id/agent-runtime/portable` | Returns the complete `PortablePresetRuntimeEnvelopeV1`: portable config and task templates. It contains no local bindings or credentials. |
| `POST` | `/import-portable` | Accepts `{ preset: PortablePresetPayload, agentRuntime: PortablePresetRuntimeEnvelopeV1 }` and atomically imports the complete preset/runtime graph in disabled, Response-only, review-required state (`201`). |
| `GET` | `/:id/agent-config/portable` | Returns config-only `PortableAgentConfigV1` with no local bindings or credentials. |
| `POST` | `/agent-config/portable/import` | Creates a foreign preset/config from a config-only `PortablePresetPayload` in inert review-required state (`201`). |
| `POST` | `/:id/duplicate` | Same-account transactional duplicate of the preset, normalized config, authorized bindings, regex companions, task templates, and review acknowledgements. |
| `POST` | `/:id/agent-runtime/repair-acknowledgement` | Record `{ reasonCode, expectedPresetRevision }` for an authenticated owner. The revision is CAS-protected; the response is a separate `repair/review` acknowledgement and does not select a runtime mode. |

| `GET` | `/agent-runtime-limits` | Returns effective process ceilings; it cannot be used to raise them. |

The shared-draft save requires both preset and config revision preconditions.
It updates prompt order and normalized config in one transaction and rejects
unknown or malformed bodies with `400`. Omitting
`expectedPresetRevision` returns `428 PRESET_REVISION_REQUIRED`; omitting
`expectedConfigRevision` returns `428 AGENT_CONFIG_REVISION_REQUIRED`.
Stale preconditions are never merged: a stale preset revision returns HTTP
`409 PRESET_REVISION_CONFLICT`, while a stale config revision returns HTTP
`409 AGENT_CONFIG_REVISION_CONFLICT`. On success the route returns the
canonical saved `{ preset, editor }` state with refreshed `presetRevision`
and `configRevision`; replace the local draft with that state. A caller that
receives a conflict must refresh the canonical editor and intentionally
reapply its preserved draft.
Clients submit every exact Loom reference against `expectedPresetRevision`; they must not pre-advance those references. The server alone determines whether prompt order changed and advances preset authority only for that change. It rebases a submitted reference only when the persisted and submitted blocks at that exact `promptOrder` occurrence have the same ID, effective block revision, and semantic content. A moved, new, replaced, or occurrence-locally changed duplicate remains pinned to the authored old preset revision and returns `repair_required / loom_reference_repair_required` for explicit review. Config-only changes and current-reference repairs retain the preset revision while advancing config authority as needed.
A config-only shared draft has no future preset authority to claim: a direct `current + 1` pre-pin against unchanged prompt order remains `repair_required` until the exact reference is resubmitted at the current preset revision.
Structural category-marker blocks are never valid Loom sources. A direct current-revision category reference remains quarantined as `repair_required`; only a non-category exact block occurrence can return the runtime to `ready`.
`repair_required` is not imported-review provenance and is never repairable by acknowledgement. The editor projects concrete validation/repair rows for it; `disabled_import` items remain exclusive to sticky foreign-import review reason codes.

The separate ordinary `PUT /api/v1/presets/:id` route always requires
`expected_cache_revision`. When the body includes top-level `agent_config`, it
additionally requires snake_case `expected_config_revision`; an ordinary update
without `agent_config` does not require that config precondition. This is
distinct from the dedicated `/agent-config` route above, whose preconditions
are camelCase. A stale ordinary preset precondition returns HTTP
`409 PRESET_REVISION_CONFLICT`. Treat that response as an authoritative
concurrency boundary: preserve the local draft, surface conflict/review UI,
and wait for an explicit canonical reload. Clients must not fetch the newer
revision and automatically retry the stale mutation, because doing so bypasses
the compare-and-swap guard and can silently overwrite the newer preset. A stale
ordinary Agentic-config write instead returns HTTP
`409 AGENT_CONFIG_REVISION_CONFLICT` with the canonical snake_case fields
`{ preset_id, expected_config_revision, actual_config_revision, preset,
agent_config_revision, agent_config, agent_config_review, cache_revision }`.
Use `PUT /api/v1/presets/:id/agent-config` when changing config, slots,
cognition, context, tasks, and blocks together.

`cache_revision` is the strict preset-revision authority. The ordinary update
classifier compares persisted values recursively: object insertion order is
irrelevant, while array order remains significant. A structurally identical
full PUT is a no-op and advances neither preset nor config revision. Any real
ordinary change to name, provider, engine, parameters, prompt order, prompts,
metadata (including prompt-variable values), or preset-bound regex companions
advances `cache_revision` exactly once. Built-in default-preset metadata
upgrades use this same mutation path rather than writing revision columns
directly.

Whenever an ordinary mutation advances the preset revision, the same database
transaction marks every exact Loom source reference for repair: all four Loom
policy buckets, phase instruction references, and every child instruction
subset. The dedicated shared Agent Runtime editor is the sole safe exception;
it updates prompt blocks and normalized config together and atomically rebases
only exact references that satisfy the persisted same-occurrence predicate.
Other authored references are preserved at their old revision and quarantined
for explicit repair. A config-only repair remains usable while the preset is
quarantined and does not itself advance the preset revision; submitting an
already-ready, structurally identical config is also a no-op.

The shared editor rebases a submitted reference only when that referenced block occurrence already exists at the exact `(blockId, promptOrder)` pair and keeps both its effective block revision and semantic block content (the dynamic `revision` field is excluded from that comparison). Duplicate block IDs are therefore compared independently at their referenced prompt-order positions. Newly introduced, replaced, or moved occurrences are not rebased until they have been committed as authority. Any content or effective-revision change outside that safe case follows the ordinary repair/quarantine path rather than silently moving exact references.
Portable preset payloads likewise permit duplicate prompt-block IDs at distinct array positions. Loom policy, phase, and child-subset sources round-trip by exact `promptOrder` occurrence; import quarantines missing, mismatched, category, stale, or future-pinned occurrences. Legacy sources without `promptOrder` are accepted only when their block ID identifies exactly one occurrence; duplicate-ID ambiguity never falls back to the first block.

Removing a Prompt Stash entry is one atomic mutation across settings and every owning preset. The response reports `{ removed, presetAuthorityChanged, presetAuthorities }`; all changed owners are returned with their authoritative preset/config revisions. A settings-only removal reports no preset-authority change, and a missing/repeated removal is an exact no-op. Rollback publishes neither settings nor preset events.

After any successful preset or preset-profile authority mutation, frontend
writers commit through one runtime-authority invalidation point. This applies
to InputArea and LoomBuilder, bound and unbound saves, and chat, persona,
character, connection, and default profile mutations. The commit invalidates
cached one-use decision tokens, fences unresolved display and send preflights,
and makes every mounted runtime projection refetch. Responses from an older
authority epoch cannot republish. A generation already admitted before the
commit keeps its frozen mode, but a later Send cannot use the old authority.
If readiness fails, preflight rejects before outbox creation, attempt creation,
or provider invocation.

The durable per-chat mode override is separate from the preset. `PUT
 /api/v1/chats/:id/agent-mode` accepts exactly:

```ts
{ mode: 'response' | 'agentic', expectedRevision: number }
```

The revision precondition is required on every write; use `0` for the first
write. A stale revision is rejected rather than merged. The response is
`{ chatId, mode, revision, state, appliesTo: 'next_turn' }`.
`DELETE /api/v1/chats/:id/agent-mode` accepts exactly
`{ expectedRevision: number }` and returns the same response shape with
`mode: null`. Both changes apply to the next Turn Session, including while
another generation is active; they do not alter the current run.

The durable override is not included in portable config, LumiHub data, or
archives. One-turn choices and decision tokens are never persisted in a
preset. `POST /api/v1/presets/:id/agent-runtime/repair-acknowledgement`
accepts exactly `{ reasonCode: string, expectedPresetRevision: string |
number }` and returns `{ presetId, presetRevision, reasonCode,
acknowledgedAt, revision, scope: 'repair/review', state: 'acknowledged' }`.
The acknowledgement records owner review for the preset revision; it does
not grant a missing capability, select a mode, or bypass readiness.

### Extension boundary

The `spindle.presets.*` extension methods continue to manage ordinary preset
CRUD and prompt blocks. Extensions must preserve unknown metadata keys, but
must not treat the legacy keys as consent or attempt to implement runtime
resolution. The normalized Agent runtime routes above are authenticated
server operations. Agentic execution exposes no extension Tool Library, MCP,
Council, or generic Spindle callback surface; those remain Response-only.

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

// Update the preset metadata using the revision returned by create/get.
const updated = await spindle.presets.update(newPreset.id, {
  expected_cache_revision: newPreset.cache_revision,
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
| `update(presetId, input)` | `Promise<UserPresetDTO>` | Update a preset. `expected_cache_revision` is always required; when top-level `agent_config` is present, snake_case `expected_config_revision` is additionally required. On success the canonical saved DTO (including its refreshed `cache_revision`) is returned. A stale cache write is HTTP `409 PRESET_REVISION_CONFLICT`; a stale Agentic-config write is HTTP `409 AGENT_CONFIG_REVISION_CONFLICT` with the canonical conflict fields documented below. Refresh the canonical state and intentionally reapply the draft rather than merging or overwriting. |
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
  metadata: Record<string, unknown> // reserved runtime keys are scrubbed
  cache_revision: number
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

`UserPresetDTO` is the extension wire shape and does not include normalized
Agent runtime configuration. Use the authenticated
`/api/v1/presets/:id/agent-config` and portability routes above for V2 config,
bindings; extension CRUD cannot grant or resolve Agentic execution.

## UserPresetCreateDTO


| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Preset name |
| `provider` | `string` | Yes | Preset provider, usually `loom` for native Lumiverse presets |
| `engine` | `string` | No | Engine identifier. Defaults to `classic` |
| `parameters` | `Record<string, unknown>` | No | Provider parameters and Loom sampler/custom-body settings |
| `prompt_order` | `PromptBlockDTO[]` | No | Ordered prompt blocks, including structural category markers |
| `prompts` | `Record<string, unknown>` | No | Prompt behavior, completion settings, and advanced settings |
| `metadata` | `Record<string, unknown>` | No | Preset metadata and extension-specific data; reserved Agent runtime keys are import-only and are scrubbed |

## UserPresetUpdateDTO

`expected_cache_revision` is always required and must be the
`cache_revision` returned by the most recent `get`, `list`, `create`, or
successful `update` response. A missing precondition is HTTP
`428 PRESET_REVISION_REQUIRED`. When top-level `agent_config` is present,
snake_case `expected_config_revision` is additionally required; an ordinary
update without `agent_config` does not require it. Its missing precondition is
HTTP `428 AGENT_CONFIG_REVISION_REQUIRED`. A stale config precondition is HTTP
`409 AGENT_CONFIG_REVISION_CONFLICT` with canonical
`{ preset_id, expected_config_revision, actual_config_revision, preset,
agent_config_revision, agent_config, agent_config_review, cache_revision }`;
no update is applied.
A stale cache precondition is HTTP
`409 PRESET_REVISION_CONFLICT` with the expected and actual cache revisions;
no update is applied. Use the returned canonical state (or refresh it) before
preparing the next write. All other fields from `UserPresetCreateDTO` are
optional, including `name` and `provider`.

!!! note "Prompt variable cleanup and Agentic revisions"
    When `prompt_order` or `metadata` is updated, Lumiverse prunes stale `metadata.promptVariables` entries that no longer correspond to a variable definition on any matching block occurrence. Same-ID occurrences keep their schemas distinct during validation, so a variable defined by either occurrence is preserved rather than overwritten by the last block. A changed `metadata.promptVariables` map is a prompt-input revision: normalized Agentic Loom references pinned to the prior preset revision are moved to `loom_reference_repair_required` instead of remaining deceptively ready. This matches the built-in preset editor behavior.

---

## Prompt Blocks

Prompt blocks are managed through `spindle.presets.blocks`. Block operations update the parent preset's `prompt_order` and trigger the normal preset update flow. Reads use the canonical occurrence coordinate `{ blockId, promptOrder }`: the zero-based `promptOrder` selects the occurrence and `blockId` verifies its identity. Every create, update, and delete also requires the caller-observed `expectedCacheRevision`. Lumiverse compares that revision before resolving a mutation target and retains it on the atomic conditional preset write, so a concurrent insert, delete, or reorder conflicts without touching a shifted same-ID sibling. Structural mutations reindex later blocks; refresh both the preset and `list()` before preparing the next mutation. There is no ID-only or revision-optional alias.

### Block Usage

```ts
// Read the current authority and canonical prompt order
let preset = await spindle.presets.get('preset-id')
if (!preset) throw new Error('Preset not found')
let blocks = await spindle.presets.blocks.list('preset-id')

// Get is read-only and verifies the occurrence at prompt order 0
const firstOccurrence = { blockId: blocks[0].id, promptOrder: 0 }
const block = await spindle.presets.blocks.get('preset-id', firstOccurrence)

// Every mutation is bound to the caller-observed preset revision
const newBlock = await spindle.presets.blocks.create('preset-id', {
  name: 'Style Guide',
  content: 'Write with concise, vivid prose.',
  role: 'system',
  position: 'pre_history',
  enabled: true,
}, { expectedCacheRevision: preset.cache_revision })

preset = await spindle.presets.get('preset-id')
if (!preset) throw new Error('Preset not found')
blocks = await spindle.presets.blocks.list('preset-id')
const newTarget = {
  blockId: newBlock.id,
  promptOrder: blocks.length - 1,
  expectedCacheRevision: preset.cache_revision,
}
const updatedBlock = await spindle.presets.blocks.update('preset-id', newTarget, { enabled: false })

// Refresh the revision again after update before deleting
preset = await spindle.presets.get('preset-id')
if (!preset) throw new Error('Preset not found')
const blockDeleted = await spindle.presets.blocks.delete('preset-id', {
  ...newTarget,
  expectedCacheRevision: preset.cache_revision,
})

// Indexed create is also revision-bound because it structurally reindexes
// later occurrences.
preset = await spindle.presets.get('preset-id')
if (!preset) throw new Error('Preset not found')
const category = await spindle.presets.blocks.create('preset-id', {
  name: 'Tone',
  marker: 'category',
  categoryMode: 'radio',
  content: '',
}, { index: 0, expectedCacheRevision: preset.cache_revision })
```

### Block Methods

| Method | Returns | Description |
|---|---|---|
| `list(presetId)` | `Promise<PromptBlockDTO[]>` | Return the preset's ordered prompt blocks. The array index is the canonical `promptOrder`. |
| `get(presetId, occurrence)` | `Promise<PromptBlockDTO \| null>` | Read the block only when both `occurrence.promptOrder` and `occurrence.blockId` match. Returns `null` on missing or mismatched coordinates. Refresh after structural mutations. |
| `create(presetId, input, options)` | `Promise<PromptBlockDTO>` | Create only against `options.expectedCacheRevision`. `options.index` inserts at a zero-based position; omitted appends. A stale revision conflicts without inserting. |
| `update(presetId, target, input)` | `Promise<PromptBlockDTO>` | Update only when the occurrence and `target.expectedCacheRevision` match current authority. All fields except `id` are optional. |
| `delete(presetId, target)` | `Promise<boolean>` | Delete only when the occurrence and `target.expectedCacheRevision` match current authority. Returns `false` only for a missing/mismatched occurrence at the current revision; stale revisions conflict. |

### PromptBlockOccurrence and mutation authority

```ts
type PromptBlockOccurrence = {
  blockId: string
  promptOrder: number // zero-based canonical prompt_order index
}

type PromptBlockMutationTarget = PromptBlockOccurrence & {
  expectedCacheRevision: number
}

type CreatePromptBlockOptions = {
  expectedCacheRevision: number
  index?: number
  userId?: string
}
```

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

Prompt-variable names are scoped to their defining block while Lumiverse renders
that block. If another block defines the same name, `{{var::name}}`,
`{{getvar::name}}`, and `{{.name}}` still resolve the current block's own saved
instance. Runtime `{{setvar::name::value}}` writes remain effective for the rest
of that block and the outer local-variable scope is restored afterward.

When a chat, persona, character, connection, or default preset profile is
active, its saved prompt-variable values are overrides rather than a complete
replacement. Blocks and variable keys absent from the profile inherit the
current values in `metadata.promptVariables`; bindings created before profile
variable snapshots therefore continue to use the preset configuration.

Lumiverse evaluates preset blocks and prompt settings itself; macro
interceptors do not receive the complete preset template. If a block references
a character field such as `{{description}}` or `{{system}}`, that field is
offered to interceptors separately. `ctx.sourceHint` identifies which field was
provided. This keeps preset variables and system macros stable while still
allowing extensions to process character content. Regex scripts attached to a
preset follow the same rule. Character fields receive the same local, chat, and
global variables available at their original position in the preset.

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
const preset = await spindle.presets.get('preset-id', 'user-id')

if (!preset) throw new Error('Preset not found')

const block = await spindle.presets.blocks.create(
  preset.id,
  { name: 'Operator Note', content: '...' },
  {
    userId: 'user-id',
    expectedCacheRevision: preset.cache_revision,
  },
)
```

## Best Practices

- Treat `parameters`, `prompts`, and `metadata` as owned by the preset editor unless you intentionally manage those fields.
- Namespace extension-specific metadata under your extension identifier to avoid collisions.
- Prefer block CRUD for localized prompt edits instead of rewriting the entire `prompt_order` array.
- Use `categories.list()` for UI or analytics; create/update/delete category headers through `blocks.*`.
- Check `spindle.permissions.has('presets')` before showing preset-management UI.
