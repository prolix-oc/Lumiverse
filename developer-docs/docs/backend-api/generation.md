# Generation

!!! warning "Permission required: `generation`"

Fire LLM generations programmatically.

## `spindle.generate.raw(input)`

Direct generation — you specify the provider, model, and messages.

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Summarize this text: ...' },
  ],
  parameters: { temperature: 0.3, max_tokens: 200 },
  connection_id: 'optional-connection-id',
})
// result: { content: string, finish_reason: string, usage: { ... } }
```

## `spindle.generate.quiet(input)`

Uses the user's active connection profile and preset parameters.

```ts
const result = await spindle.generate.quiet({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
})
```

`raw`, `quiet`, and `batch` are direct provider helpers. They do not run prompt
assembly, context handlers, or the pre-generation `registerInterceptor` chain.

## `spindle.generate.batch(input)`

Run multiple generation requests.

```ts
const results = await spindle.generate.batch({
  requests: [
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
  ],
  concurrent: true,
})
// results: Array<{ index, success, content?, error? }>
```

## GenerationRequestDTO

| Field | Type | Description |
|---|---|---|
| `messages` | `LlmMessageDTO[]` | The message array to send |
| `parameters` | `Record<string, unknown>` | Optional LLM parameters (temperature, max_tokens, etc.) |
| `connection_id` | `string` | Optional. Use a specific connection profile (see Connection Profiles below) |
| `tools` | `ToolSchemaDTO[]` | Optional. Function/tool schemas exposed to the model (raw / quiet only). See Tool calling below |
| `reasoning` | `GenerationReasoningOverrideDTO` | Optional. Per-request override for extended-thinking settings — see Reasoning below |
| `signal` | `AbortSignal` | Optional. Cancel the in-flight LLM request when the signal fires (see Cancellation below) |

---

## Tool calling

Pass tool schemas via `tools` and the model can call them. Tool calls land in `response.tool_calls` (non-stream) or the terminal `done` chunk (stream) as `ToolCallDTO[]`. You execute the tool, then send the result back as a `tool_result` part on the next user message.

```ts
const result = await spindle.generate.raw({
  type: 'raw',
  messages: [{ role: 'user', content: 'What is the weather in SF?' }],
  tools: [{
    name: 'get_weather',
    description: 'Look up current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }],
})

// result.tool_calls?.[0] = { name: 'get_weather', args: { city: 'SF' }, call_id: 'toolu_…' }
```

Round-trip the call by appending two messages: an `assistant` with a `tool_use` part carrying the same `call_id`, then a `user` with a `tool_result` part keyed back to it.

```ts
const followup = await spindle.generate.raw({
  type: 'raw',
  messages: [
    { role: 'user', content: 'What is the weather in SF?' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { city: 'SF' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_abc', content: '72F, clear' },
      ],
    },
  ],
  tools: [/* same schema */],
})
```

### Parts

| Type | Fields | Used by |
|---|---|---|
| `text` | `text: string` | Any role |
| `image` | `data: string` (base64), `mime_type: string` | `user` |
| `audio` | `data: string` (base64), `mime_type: string` | `user` |
| `tool_use` | `id`, `name`, `input: Record<string, unknown>` | `assistant` |
| `tool_result` | `tool_use_id`, `content: string`, `is_error?: boolean` | `user` |

Use the same `call_id` returned in `ToolCallDTO` as `tool_use.id` and `tool_result.tool_use_id`. Provider adapters translate to each upstream's native shape (Anthropic content blocks, OpenAI `tool_calls` / `role:"tool"`, Gemini `functionCall` / `functionResponse`, OpenAI Responses API `function_call` / `function_call_output`).

!!! note "Tool result formatting"
    Anthropic requires the `tool_result` parts to come first in the content array of the user message that follows an assistant `tool_use`. The host enforces this; you just need to put them in a dedicated user message that immediately follows.

### ToolSchemaDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Function name the model uses to invoke the tool |
| `description` | `string` | Natural-language description shown to the model |
| `parameters` | `JSONSchema` | JSON Schema for the call arguments |

### ToolCallDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Tool name matching one of your `ToolSchemaDTO` entries |
| `args` | `Record<string, unknown>` | Parsed JSON arguments |
| `call_id` | `string` | Provider call id (Anthropic `id`, OpenAI `id`, synthetic UUID for Gemini). Pass back as `tool_use.id` / `tool_result.tool_use_id` |

---

## Agentic Turn Executions and durable WORK segments

One authenticated Agentic generation owns one Turn Execution and one attempt
composed of ordered Work Segments. A segment's fresh provider context contains
the frozen root objective/snapshot, exact current-phase instructions and exit
criteria, frozen admitted tools/delegation and protocol capability state,
remaining budgets, host-accepted workspace records and open required IDs, and
at most the preceding bounded handoff. It excludes prior-segment provider
prose/messages, tool calls/results, hidden reasoning, opaque continuation
carrier, stale phase instructions, and unaccepted records or claims.

Those exclusions govern next-segment provider input and replay. Owner inspection exposes a dedicated bounded redacted WORK DTO containing only safe recovery state and attempt usage, segment identity/lifecycle/usage/closure, provider dispatch identity/state/accounting, typed boundaries, workspace revisions, and handoff/transition causality. It never serializes the durable resume envelope, snapshots or plans, generation parameters, user input or regeneration feedback, credential references, endpoints or fingerprints, private decision authority, hidden reasoning, or opaque continuation carriers. Public Activity stays status-only, segment output is not a per-segment user message or public token stream, and only the final tools-disabled render plus atomic commit produces the Response contract.

Every settled provider dispatch has one of six boundary classes: admissible
host tool action, tool-free stop, reasoning-only stop, reasoning-only length
exhaustion, empty provider response, or provider protocol failure. Tool actions
settle admitted effects before continuation; stop classes consume bounded
unsigned recovery; length may roll over; empty/protocol failures recover only
under explicit host policy and otherwise close with a typed cause. No provider
prose selects routing and no unknown in-flight dispatch is replayed.

Dispatch settlement durably reserves every validated mutating operation before
its tool runs, then effect finalization binds each successful receipt—or typed
no-op/failure—exactly once after execution. Every reservation, receipt, and
effect carries its authenticated segment ID, logical dispatch, and root or
child frame ID. Finalization binds only receipts owned by that tuple while
validating the complete global workspace-revision chronology; revisions owned
by independently executing child frames are legitimate gaps, not missing root
effects. A dispatch with unresolved reservations cannot advance, transition,
or close, and startup recovery backfills the mutation-to-link crash window
without replaying the mutation.

Pre-scheduled intrinsic children run before a Segment has a provider dispatch.
Their immutable frame grant is therefore authoritative: profile-declared
workspace capabilities may narrow that grant but can never add to it. Such a
child returns its bounded result directly and receives neither mutating
workspace tools nor a synthetic assigned task. Provider-delegated children can
receive the exact admitted workspace subset only after the host has persisted
the corresponding dispatch-owned assignment and mutation authority.

On abort or failure, every assigned child is terminal-settled first and its
owned receipt/cursor is recorded before aggregate dispatch finalization.
Durable assignment authority lets startup repeat that ordering after a crash;
missing child settlement effects are never fabricated ahead of the mutation.

Attempt budget, Segment budget, hard per-dispatch output cap, and protected
recovery/future-phase reserves are independent. Closure reports typed `failed`,
`exhausted`, or `cancelled` causes. Agentic WORK requires at least one admitted
host tool plus frozen provider capability with `nativeToolContinuation=true`
and `toolContinuationMode=native`; live and recovered root and child dispatches
revalidate that exact pair before provider work. Legacy synthesized continuation
remains available only to Response/Council and fails Agentic readiness before
WORK. Required mode additionally requires positive required-tool capability;
unknown/custom capability fails closed before dispatch.

A repeat creates a new Segment and occurrence; rollover creates a new Segment
in the same occurrence. A skipped custom phase creates no custom Segment. With
no authored custom phases, WORK admits one built-in null-phase Segment. When
all authored phases are optional and deterministically skipped, exactly one
built-in Segment may be admitted only under frozen authority containing every
exact skipped phase ID; retry and recovery validate that same authority. A
completed required source followed only by skipped optional phases closes
terminally without admitting a null successor. Persistence orders reserve →
in-flight → settle → handoff close → successor admission, idempotently under
exact identity/CAS, so recovery cannot
duplicate provider work, tools-disabled render, or final commit.

The durable resume envelope has its own 8 MiB canonical bound. Envelope digest
creation and durable validation use that same bound; the generic 1 MiB WORK
record bound does not reject an otherwise admissible exact resume authority.

Persistent-workspace required-child tasks are materialized before WORK execution,
but their revision never substitutes for the execution's turn-workspace revision.
When child binding commits a turn-workspace task, pre-segment owner renewal
atomically projects that turn revision into execution authority. Child workspace
operations advance private cognition authority; child completion then adopts
the returned revision into process execution and renews its durable projection
before root Segment admission. The resume envelope is frozen only when the
first Segment is admitted and binds the same turn-workspace identity and
revision used by Segment lifecycle fencing; the persistent workspace remains a
separate chat-lifetime association.
DeepSeek V4 enables thinking by default but rejects requests that also carry
`tool_choice`. The DeepSeek adapter therefore sends `thinking.type=disabled`
whenever host tool choice is present, including required standalone completion;
ordinary requests without tool choice retain the provider's default thinking.

Turn-attempt inspection is admitted before workspace and WORK-segment authority.
During that boundary, owner detail reports `workSegments: null` while the
admission target and any terminal cause remain durable. Once the exact workspace
and recovery authority exist for the attempt, inspection authenticates and
projects that segment chain strictly; malformed or stale authority still fails
closed rather than being treated as an absent pre-WORK layer.

---

## Response-mode Agents & Tools during generation

The existing preset-owned Agents & Tools pipeline is **Response mode**. Its
only executable source is `Preset.agent_config` (`AgentConfigV2`) returned by
the authenticated normalized authority. Ordinary create/update calls reject
V1 in the top-level `agent_config` DTO and scrub every runtime-looking metadata
alias without interpreting it. Explicit archive, preset-file, and LumiHub
import/migration boundaries may parse legacy `metadata.agentConfig`; they write
it once as disabled, Response-only normalized V2 and remove the legacy field.
Generation never reads runtime authority from preset metadata.
`spindle.generate.raw()`, `quiet()`, and `batch()` remain direct
provider helpers: they do not assemble a preset and do not execute
preset-owned intrinsics. With no executable Response-mode configuration,
ordinary generation and existing Council continuation behavior are unchanged.

Loom omission removes only WORK-owned policy and phase source blocks from
Response, regardless of whether the effective cognition source is normalized,
directly authored, quarantined/stale, or a legacy carrier. If exclusions leave
no enabled `chat_history` marker that is active for the current generation and
character tags, assembly inserts exactly one ephemeral host-owned structural
marker and runs the same native history, World Info, Author's Note, and
automatic Databank paths. The marker is never persisted or exported and is not
inserted when an active authored marker remains. Normal generations carry the
exact persisted source-user row IDs into assembly; a nonempty source set must
resolve to visible user rows or assembly fails before provider dispatch. Those
IDs are identity only. The empty-send nudge is admitted only when the source set
is empty, so a real current user turn cannot be replaced by a stale nudge.

### Child runtime

An enabled directly-authored intrinsic executes serially at its prompt-block
position. The child receives exactly two initial messages:

1. one host/provider-safe `system` message containing the fixed lower-authority
   derived-data guidance and the profile's literal `systemPrompt`; and
2. one `user` message containing the resolved task.

The root prompt, raw chat transcript, attachments, metadata, arbitrary chat
rows, and credentials are not copied into child context. Child tool results are
host-framed derived data and are not re-evaluated as macros. A child may use
only its profile's checked core tools and lore-scope ceiling. Dynamic
`agent_delegate` calls may narrow a selected profile at call time, but cannot
widen either grant or delegate again.

Feature admission and continuation are bounded by one root-owned ledger shared
by the root model and all child frames. The authored `maxInvocations` and
`maxToolCalls` values default to `64`, require finite safe integers of at least
`1`, and remain portable; the host rejects execution above its effective
ceilings.

| Host ceiling | Default |
|---|---:|
| Child admissions | 1,024 |
| Aggregate tool-call attempts | 1,024 |
| Logical provider requests | 2,048 |
| Physical dispatch attempts (including eligible pre-carrier retries) | 4,096 |
| Aggregate child output | 1,048,576 tokens |
| Root wall-clock duration | 3,600,000 ms |
| Detailed activity events / bytes | 512 / 512 KiB |
| Detailed lifecycle log records | 512 |
| Active roots (process / user) | 16 / 2 |
| Provider dispatches (process / user) | 16 / 4 |
| Tool executions (process / user) | 32 / 8 |

The operator may tune these process settings with the existing
`LUMIVERSE_AGENT_HOST_*` variables. The authenticated
`GET /api/v1/presets/agent-runtime-limits` endpoint exposes effective values
to the editor; it never exposes credentials or provider details.

Each provider response is consumed to an explicit complete boundary. A
complete call batch is validated before side effects, charged once, executed
serially in provider order, and appended with exactly one correlated result per
call before the next request. The loop repeats until a tool-free answer,
cancellation, deadline, context/integrity ceiling, or budget exhaustion.
Response-mode transport retries are allowed only before any carrier, token, or
tool side effect is accepted.

The host emits additive stable terminal error codes and status-only activity.
Live activity is capped at 128 retained nodes/64 KiB in the UI; the backend
publisher caps detailed events at 512/512 KiB and logs at 512 records.
Target-backed messages retain only a compact swipe-scoped aggregate. No-target
or zero-output runs use the bounded authenticated activity-runs fallback
(newest 16 per chat, 512 KiB total, 32 KiB each), so reconnect can recover
status without storing prompts, prose, arguments, results, provider carriers,
or raw exception strings.

Authored values above a host ceiling remain readable and editable but are
non-executable until lowered.
`GENERATION_ENDED` and `GENERATION_STOPPED` expose only the allowlisted
`AgentPublicErrorV1` shape when an active Agent runtime has a terminal error:
version, stable code/category, an optional bounded budget observation, and
retryability. They do not expose adapter identifiers, HTTP/provider status
codes, raw provider errors, prompts, arguments, or results.

There is one absolute root deadline and one terminal compare-and-set owner.
Completion, stop, cancellation, timeout, watchdog, provider failure, and setup
failure race through that owner; only the winner aborts descendants, persists
the bounded snapshot, emits the terminal event, and releases permits.

Each task is at most 32 KiB UTF-8 and aggregate child initial-input data is at
most 256 KiB per root. Deterministic requests rejected before admission
(invalid, unauthorized, or pre-admission limit failures) return ordered typed
errors and remain in failure summaries/activity without consuming the
child-invocation ceiling. An admitted child invocation consumes one admission
even if it later fails, is cancelled, times out, or exceeds a runtime, tool,
output, or retention budget. Every child frame is stamped with the exact
frozen concrete provider, model, and connection selected for its profile; the
host rejects a frame/dispatch identity mismatch. That same frozen identity
drives tokenization, usage accounting, and owner inspection. Deterministic
profiles use their configured `required` or `optional` failure policy:
required failure aborts generation, while optional failure records the failure,
restores an empty direct value, and binds an empty named result. A dynamic
delegation failure is returned as a typed tool error to the main model instead
of aborting it.

### Main-model continuation and provider support

For Response-mode rounds with feature tools, the host first applies
`assertAgentToolCapability()`: `toolCalling` must be true,
`toolContinuationMode` must not be `unsupported`, and
`toolsDisabledFinalization` must be true. A failing declaration rejects the
feature before any provider request. After that gate, native structured
continuation is selected if and only if both `nativeToolContinuation: true`
and `toolContinuationMode: "native"`; an admitted `legacy` mode uses bounded
assistant-text/user-result continuation. Tool and child results remain
host-framed, untrusted derived data. Provider capability declarations, rather
than a provider-name allowlist, select the serializer.

Those declarations live on `ProviderCapabilities` (`src/llm/param-schema.ts`).
Every adapter states them as literals so readiness can never infer them from an
adapter base class:

| Field | Meaning |
|---|---|
| `toolCalling` | The adapter advertises and parses host function calls. Deliberately independent of continuation mode. |
| `nativeToolContinuation` | Boolean mirror of a provider-native continuation wire format; the registry requires it to be true exactly when `toolContinuationMode` is `native`. |
| `toolContinuationMode` | `native` (correlated provider call identities and results), `legacy` (bounded assistant-text/user-result, retained for feature-inactive Council compatibility), or `unsupported` (reject agent tools before any provider request). |
| `toolsDisabledFinalization` | The adapter can issue an explicit tools-disabled finalization request once a continuation reaches its budget. `supportsToolFinalization` is the older Response/Council projection; readiness reads `toolsDisabledFinalization`. |

Response-mode feature tools are gated by `assertAgentToolCapability()`
(`src/llm/provider.ts`), which reports `provider_tool_calling_unsupported`,
`provider_tool_continuation_unsupported`, or
`provider_tool_finalization_unsupported`. Agentic admission re-checks the same
declarations on every frozen concrete connection and reports
`agentic_capability_missing_tool_calling` or
`agentic_capability_missing_tools_disabled_finalization` instead. An adapter
declaring `toolCalling: false` with `toolContinuationMode: "unsupported"` and
`toolsDisabledFinalization: false` — `pollinations-text` today — is admitted by
neither path.

Feature-inactive Council calls remain on the existing Response-only path and
do not use `assertAgentToolCapability()`. Council selects structured
continuation only when `interleavedThinking` is true; otherwise it uses
assistant-text/system-result continuation. Council, extension callbacks, MCP
tools, and generic Spindle tools are not admitted by the strict Agentic runtime
described below.

### Dry run, multiplayer, and retained activity

Dry Run carries its inspection flag across the worker boundary but never
constructs an agent runtime, exposes tools, or calls a child provider. An
executable Response-mode intrinsic reports `AgentDryRunUnsupportedError`
before provider work. An active multiplayer room omits main feature tools and
an executable intrinsic reports `AgentMultiplayerUnsupportedError` before
snapshot/provider work. Merely storing a disabled or review-required config
does not break ordinary room generation.

`stream` controls live child activity only when the profile's
`streamActivity` ceiling permits it. Activity is status-only (phase/status,
profile and tool names, timing, and cumulative counts/usage); it never carries
task text, child prose, arguments, retrieval data, result bodies, or arbitrary
provider exceptions. After a real staged/target assistant message exists, the
message may retain a compact swipe-scoped summary, not a child transcript.
Cancellation, stop, timeout, required failure, seal failure, and other
terminal paths close the child runtime and abort descendants.

## Strict single-turn Agentic runtime

Agentic is an explicit, opt-in branch of the authenticated core generation
route. It is not an extension `spindle.generate.*` helper and it never
silently downgrades to Response. A client first asks
`POST /api/v1/generate/effective-runtime` for the requested target and
`mode: "agentic"`. The UI supplies the returned one-use token; a direct caller
may omit it and the generation endpoint performs the same authenticated
resolution internally. When a token is supplied it must be unexpired and
match the current target, revisions, and readiness. If preflight reports a
repair/capability failure, the caller must explicitly choose
`mode: "response"`; an Agentic request otherwise fails closed with
`decision_refresh_required`, `agentic_runtime_unavailable`, or its stable
preflight code.

### Admission, target identity, and capability gates

The closed Agentic target union is `normal | continue | regenerate | swipe`.
`GenerationTargetV1` is an internal server snapshot that freezes
`generationType`, optional `messageId`, `swipeId`, `branchId`,
`targetCharacterId`, and target revisions before provider work. The public
generation request must not supply `branchId` or revision fields: they are not
currently wired through request normalization, and adding them produces a
target-digest mismatch. The server-owned `LiveTargetBinding` derives and
freezes authoritative branch/chat/message revisions, message index, swipe
count, and selected swipe before execution and commit.

| Target | Frozen identity and write intent |
|---|---|
| `normal` | The owned chat and its current generation revision; no target message or swipe. Commit creates the assistant message. |
| `continue` | An owned message plus an existing selected/current swipe; extends that swipe. |
| `regenerate` | An owned message; defaults to the current swipe and may target the next free swipe slot to append. |
| `swipe` | An owned message; defaults to the next free swipe slot and appends an alternative. |

The binding rejects missing or out-of-range message/swipe identity with
`agentic_target_unsupported`; concurrent changes become a revision conflict,
not an overwrite. The strict branch is limited to a single-character,
non-multiplayer, non-Council surface. Groups, multiplayer, Council, Council
tools, `impersonate`, `quiet`, and raw/batch generation remain Response/direct
paths.

Runtime resolution is concrete-first. It freezes one root logical/concrete
connection, provider, model, normalized endpoint, endpoint/credential/candidate
revisions, and an internal same-provider-domain fingerprint. Every deterministic
child connection must have the same trust-domain fingerprint. The required
capability set is `generation`, `streaming`, `tool_calling`,
`native_tool_continuation`, and `tools_disabled_finalization`; a missing
capability, unresolved/stale slot, changed target, incomplete revision set,
invalid cognition, unavailable isolate/publication health, or kill switch
prevents Agentic admission and exposes the Response escape.

A blank or whitespace-only saved endpoint is resolved centrally to the
provider's canonical default before readiness, revision hashing, decision-token
issuance, freezing, or dispatch. A nonblank custom endpoint remains
authoritative. Providers without a canonical default fail Agentic readiness
before token consumption; dispatch never invents a later fallback.

The decision token is opaque, bound to the authenticated user, chat/target,
request epoch, concrete candidate and revisions, config/bindings, input
revision digest, and readiness digest. It expires after 60 seconds; at most 16
live tokens are held per user and 512 process-wide. Purging happens before
capacity checks; a live token is never evicted. Consumption deletes the token
before ownership/binding checks, so replay, mismatch, cross-user use, and
expiry all require a fresh decision.

### Frozen snapshot and strict phases

`prompt-assembly-snapshot.service.ts` builds one bounded,
serializable `GenerationAssemblySnapshotV1` immediately before the strict
preprocessing isolate. It contains the selected preset and ordered blocks,
target chat/messages/swipes, persona/character/group facts, prompt-variable
state, active regex rows, settings used by macros/token accounting, concrete
connection identity, normalized V2 config, frozen Loom/task cognition policy,
immutable tool/participant availability, preparation limits, and a closed
`InputRevisionSetV1`. The host resolves native World Info once, including
keyword, constant, and vector activation, native ordering, budgets, cache,
state, and activation provenance; the strict worker consumes that finalized
projection and does not run a parallel World Info implementation. Private World
Info activation evidence is a closed, content-free host-only record: native and
fallback producers emit the same bounded fields, while snapshot identity and the
input revision digest bind that evidence to its authenticated source revision
set. Runtime admission aggregates a multi-entry World Info fence from every
authoritative member ID and source revision in canonical member order. Each
entry fence hashes source-owned fields, including content, but excludes collector
order, turn-derived activation, and per-turn state; the shared membership digest
also rejects member additions and removals. This does not reorder native semantic
entry activation or its vector source fingerprint. ASSEMBLE freezes the finalized
projection and COMMIT rechecks exact membership, source revisions, and source
content without exposing content in revision evidence. Native
Databank retrieval remains outside Loom and is projected from authenticated
live attached objects. `extensionData` and `ambientSpindleData` are explicitly
`null`; no database handle, callback, extension registry, or live Spindle
registry crosses the boundary.
The snapshot also carries exact host-native structural values for
`description`, `personality`, `persona`, `scenario`, and `examples`;
`chat_history` remains structural rather than authored text. Native history uses
the visible context anchor and excludes hidden rows from both WORK and RENDER.
For the current user turn, authenticated ownership/chat/swipe/visibility checks
seal image and audio descriptors from authoritative storage rows, MIME bytes,
and per-item/aggregate caps before any provider call. WORK and RENDER then
materialize those descriptors as typed multipart content; the textual
`(attached)` sentinel is removed whenever real media is present and is never a
substitute for a validated part.

The strict worker protocol has only two operations:
`compile_agent_assembly` and `prepare_agent_render`. `AssemblyPlanV1` returns
ordered provider messages made of literal, authenticated-media, and result-slot
segments, deterministic
child descriptors in traversal order, bounded result slots, activation/token
evidence, the complete input revision set, context snapshot, and typed deferred
deltas. Preflight rejects generated, nested, transformed, recursive, or
out-of-order result-slot references. The host reserves and runs children in
descriptor order, then substitutes each bounded child result exactly once as
literal bytes; it does not run macros, regexes, assembly, or callbacks over
child output or final messages.

`compile_agent_assembly` is verified in two distinct, terminable isolates:
`agentic-preprocessing` produces the accepted plan and
`agentic-assembly-verifier` independently compiles the same frozen snapshot.
Each pool has one worker; their outputs are compared after request identity is
removed, and verifier bytes are discarded. The pair shares one queue admission,
abort signal, wall-clock deadline, and host limits; the cooperative CPU budget
is split between the two isolates. A mismatch, malformed result, cancellation,
timeout, or unhealthy backend fails the operation. The host never executes the
assembly compiler in the main process. `prepare_agent_render` runs through the
terminable strict pool and has the same no-provider/no-live-DB/no-callback
boundary.

The public Turn Session projection uses the canonical lifecycle
`ADMIT → ASSEMBLE → WORK → PREPARE_COMMIT → RENDER → COMMIT → TERMINAL`,
with independent `workStatus` and `workOutcome` fields. The coordinator names
`COMPLETE`, `COMMITTING`, `COMMITTED`, and `COMMIT_FAILED` in the table below
are internal execution states, not public phase values: `COMPLETE` projects as
`PREPARE_COMMIT`; `COMMITTING`/`PREPARE_COMMIT` project as `COMMIT`;
`COMMITTED` projects as terminal `completed`; and `COMMIT_FAILED` projects as
terminal `failed`. Internal `CANCELLED` projects as terminal `stopped`;
`TIMED_OUT` (including `root_wall_clock_limit_exceeded`) projects as terminal
`failed`; and `EXHAUSTED` projects as terminal `exhausted` only for a
host-enforced budget or limit exhaustion.

| Phase | Contract |
|---|---|
| `ASSEMBLE` | Freeze the snapshot, validate the effective decision, compile `AssemblyPlanV1` in two independently supervised terminable isolates, and compare their plans. No generation mutation or child execution occurs. |
| `WORK` | First reserve and execute the deterministic child descriptors in traversal order, substituting each bounded result once; then run the root provider loop with bounded in-memory provider work notes. The allowlist is `complete_turn`, workspace reads (`workspace_read_section`, `workspace_read_page`), workspace mutations (`workspace_create_task` (root-only), `workspace_update_assigned_progress` (child-only), `workspace_submit_child_result` (child-only), `workspace_accept_submission` (root-only), `workspace_record_finding`, `workspace_record_decision`, `workspace_record_question`, `workspace_attach_artifact`, `workspace_propose_publication`), `agent_delegate`, and the six core retrieval tools: `lore_list_books`, `lore_get_book`, `lore_list_entries`, `lore_get_entry`, `lore_search_entries`, and `chat_search_history`. |
| `COMPLETE` | The post-acceptance boundary after the final custom phase's standalone `complete_turn` is accepted, or after standalone final acceptance when no custom phase is active: required tasks, actions, submissions, and calls are settled, and the workspace is frozen for finalization. Tool-free boundaries are re-prompted in WORK while budget remains; exhaustion enters `EXHAUSTED` with no render or commit. |
| `RENDER` | Use the same frozen root connection and model with `tools: []`, `toolMode: "finalization"`, and one final-render reservation. Only bounded host-accepted findings, accepted task submissions, and explicitly response-shaping completion guidance cross from private WORK; raw retrieval and work notes do not. Native continuation may reuse only that frame’s opaque adapter carrier; legacy continuation uses only the private frame transcript. A returned tool call is a protocol failure and is never executed. |
| `PREPARE_COMMIT` | Send frozen render content plus pure snapshotted inputs to `prepare_agent_render` in the strict isolate. It performs bounded reasoning-tag cleanup, response transforms, formatting healing, source-message/macro preparation, target/swipe reconciliation, and usage calculation, returning typed deltas only. |
| `COMMITTING` | Recompute every `InputRevisionSetV1` member. A single CAS owns this boundary; cancellation/deadline can win before it, while Stop after it is `too_late`. |
| `COMMITTED` | One synchronous SQLite transaction writes the message/swipe/extras, authorized macro/source/chat/world-info/regex deltas, artifact references, a mutable `COMMITTING` projection, the idempotent receipt, and the execution's `COMMITTED` CAS. Duplicate commit returns the existing receipt. A second exact-identity convergence transaction terminalizes the persistent Turn Session, owner inspection attempt, immutable Agent Run projection, compatibility activity, and terminal outbox. |

The record/artifact/publication mutations—`workspace_record_finding`,
`workspace_record_decision`, `workspace_record_question`,
`workspace_attach_artifact`, and `workspace_propose_publication`—are
root/orchestrator-only. Child profiles can author only the four closed
workspace capabilities documented by the preset contract; immutable frame
admission may narrow that profile ceiling further.

Before every root WORK provider dispatch, the host rebuilds one concise private structured phase-control envelope from live state: `{ kind: "host_private_phase_control_v1", currentPhaseId: string | null, admittedRootToolNames: string[], openRequiredTaskIds: string[], completeTurn: { instruction: "MUST call complete_turn as the sole tool call after the current custom phase exit predicate is satisfied; without an active custom phase, call it only after all completion gates are settled.", callMode: "standalone_only", nonFinalAcceptance: "phase_advanced", nonFinalWorkContinues: true, terminalAcceptance: "final_custom_phase_or_no_active_custom_phase_only" } }`. Future conditional tasks are never speculated. This message belongs only to private WORK input, is not persisted, and is not copied into RENDER, the public workspace projection, or Response.

Unknown phase transitions fail closed. A reversible-phase provider/protocol
failure, cancellation, or deadline enters `FAILED`, `CANCELLED`, or
`TIMED_OUT`; budget exhaustion enters `EXHAUSTED`. `COMMITTING` enters
`COMMITTED` only with its receipt, otherwise `COMMIT_FAILED`. The durable
execution is the primary terminal cause. Pool and compatibility terminal events
publish only after all durable derived surfaces commit; projection failure never
relabels the WORK/COMMIT cause as `projection_unavailable`.
Admission failures that occur after execution creation use the same durable-first
boundary; they do not terminalize inspection, Turn Session, or pool state from
cleanup. If the source chat was already deleted, chat-owned projections no
longer exist: the detached persistent Turn Session is terminalized with the
execution, the pool is settled afterward, and no chat websocket event is sent.
The generic generation Stop path also recognizes an exact owner/chat/turn whose
live registration was released after a terminal publication fault. It invokes
the dormant Agent Run Stop owner, repairs the terminal transaction, and settles
the visible pool only after that repair; owner or chat mismatch fails closed.
An already-terminal repair returns `status: "terminal"` with the canonical Agent
Run outcome and `stopped: false`; only a cancellation that wins a reversible
phase returns `status: "accepted"` and may render Generation stopped.

The strict preprocessing ceilings are immutable host defaults: 8 MiB input,
8 MiB output, 16 MiB cumulative expansion, 2 MiB per operation, 1,024 prompt
blocks, 512 active scripts, 1,024 compiled patterns, 10,000 macro
resolutions, 512 trim strings, 30 seconds cooperative CPU, 60 seconds wall
clock, two total workers (one in each paired assembly pool), four queued jobs
per user, and 32 process-wide queued jobs. Only lower test/host overrides are
accepted. Stable isolate failures are
`invalid_input`, `limit_exceeded`, `queue_full`, `worker_disabled`,
`worker_unavailable`, `worker_crashed`, `worker_timed_out`,
`worker_malformed`, `cancelled`, and `requires_response_mode`.

### Cancellation, recovery, and compatibility events

The request `AbortSignal` is connected to the Agentic owner. UI-owned generation
requests also carry a client-minted `request_authority_id`, scoped by user and
chat. The backend reserves that authority synchronously before effective-runtime
resolution or chat-mode admission. `POST /api/v1/generate/stop` accepts the
same authority with `chat_id`; therefore an id-less Stop can tombstone and abort
a request suspended before generation-ID registration. The authority is copied
to pool status and generation lifecycle events so a stopped request cannot be
resurrected by WS-before-HTTP ordering. Legacy callers without the field retain
the generation- and chat-scoped behavior.

Exact root `POST /api/v1/agent-runs/:turnId/stop` is projection-gated: it accepts
a reversible `ASSEMBLE` or `WORK` run and returns `too_late` from `COMPLETE`,
`RENDER`, `PREPARE_COMMIT`, or `COMMITTING` onward. The generation Stop route
uses the same Agentic owner and returns `{ stopped: boolean, status: "accepted" |
"terminal" | "too_late" | "not_found", terminal?: AgentRunStopResultV2 &
{ generationId: string } }`. The terminal member is present only for an
already-terminal durable run and must be consumed as canonical before client
request/stream settlement; it is never an accepted Stop. A generation-ID race
may try the supplied chat fallback. A stop or deadline that wins before
`COMMITTING` leaves no authoritative generation write. Client navigation is
not Stop authority:
background swipe admission remains valid, projects no tokens into another
active chat, and recovers once from the correlated pool when that chat reopens.
Startup runs `reconcileStartupState()` before `Bun.serve`: imports, artifact
blobs, turns, and Agent Run projections reconcile sequentially, then isolate
backends are probed. Receipt-backed success repairs the persistent Turn Session,
inspection attempt, Agent Run projection, and terminal outbox in one transaction;
noncommitted terminal execution repair uses the same all-or-nothing owner set.
Recovery is idempotent and never publishes an ephemeral pool or compatibility
terminal event before that durable boundary. Agentic readiness requires successful import/artifact/turn
and healthy projection stages, a usable publication store, and terminable
isolate health; any failed gate closes Agentic while Response remains
available. The startup stage records stable failure outcomes rather than
dispatching providers or publishing events.
Readiness additionally requires the operational rollback switch below to be `auto`: the readiness vector carries
`killSwitchState` and adds the `kill_switch_off` reason whenever it is not.
The startup vector contains only those server-owned components that can be
settled before a request selects a provider, preset binding, context snapshot,
or input revision set. Provider capabilities, configuration/binding validity,
context ACL authorization, and input-revision completeness are therefore
request-admission checks: the effective-runtime decision validates the exact
frozen request before issuing a dispatchable Agentic decision. A healthy
startup vector never substitutes for those per-request checks.

Terminal history remains immutable during this pass except for the exact legacy
stale-decision writer defect: a receipt-free `FAILED` execution with
`decision_refresh_required` and the old `failed`/`stale_input` outcome is
reconciled once to canonical `rejected` with a new projection revision.
Restart replay is idempotent; every other terminal conflict still fails startup
closed instead of rewriting durable history.


Agentic turns join the standard generation compatibility stream without
exposing private work:

| Event | Agentic emission |
|---|---|
| `GENERATION_STARTED` | Emitted when the owned execution/pool entry is created; includes generation/chat IDs, root model, target message/swipe, and target type. |
| `STREAM_TOKEN_RECEIVED` | Emitted only for provisional final-render tokens; carries the generation/chat IDs, token, sequence, and stream offset. It never carries WORK notes, reasoning, tool data, or child output. |
| `MESSAGE_SENT` / `MESSAGE_EDITED` | Emitted after the commit transaction, for `normal` or an existing target respectively; carries the chat/message handoff identifiers and content, not private work data. |
| `GENERATION_ENDED` | Emitted for completed or failed terminal status with generation/chat IDs, optional `messageId` and content, target identity, and a stable error code when applicable. |
| `GENERATION_STOPPED` | Emitted for cancellation with generation/chat IDs, content, target identity, and the same allowlisted terminal fields. |

Detailed phase/activity data is read from the authenticated Agent Run
projection, not inferred from message text or stream silence. Work prose,
reasoning, provider carriers, raw tool arguments/results, credentials, and
private child content never enter compatibility events, messages, or the
view-only workspace projection.

### Operational rollback switch

`LUMIVERSE_AGENTIC_RUNTIME` is a server-process environment variable and the
supported way to withdraw the strict runtime without a schema change. It is read
only from the server environment — never from a request, token, preset, chat, or
stored setting — so no client can raise it.

| Value | Effect |
|---|---|
| `auto` | The runtime may become ready. Every gate above still applies; `auto` alone never forces readiness. |
| anything else | `off`. Agentic is closed and Response-mode Agents & Tools continues unchanged. |

Only the exact literal `auto` enables the branch: unset, empty, `off`, `AUTO`,
`1`, and `true` all resolve to `off`, so a default install is fail-closed even
when a preset is fully configured. While the switch is `off`,
`getAgenticRuntimeStatus()` reports `enabled: false`, the readiness vector
carries `killSwitchState: "off"` and the `kill_switch_off` reason, and
`POST /api/v1/generate/effective-runtime` reports the Response escape; an
Agentic request still fails closed instead of downgrading silently.

Rollback is therefore a restart with the variable removed or set to `off`. It
changes no schema and deletes no data: preset `AgentConfigV2`, cognition state,
and existing Agent Run projections are retained and become live again when the
switch returns to `auto`. Schema rollback is the separate, narrower boundary in
[Storage > Pre-bundle SQLite backup and downgrade boundary](storage.md#pre-bundle-sqlite-backup-and-downgrade-boundary).

### Implementation anchors

- `src/services/generate.service.ts`: `GenerateInput.mode`,
  `runtime_decision_token`, and the Response/Agentic branch in
  `startGeneration()`.
- `src/services/agent-runtime-decision.service.ts` and
  `src/types/agent-runtime-decision.ts`: concrete-first resolution,
  capability/readiness checks, `GenerationTargetV1`, and one-use token store.
- `src/services/prompt-assembly-snapshot.service.ts`:
  `GenerationAssemblySnapshotV1`; `src/types/agent-preprocessing.ts`:
  `AssemblyPlanV1`, `RenderPreparationInputV1`, and preparation limits.
- `src/services/agentic-preprocessing-worker-client.ts` and
  `src/services/isolate-pool.ts`: paired independent assembly compilers,
  shared admission/deadline, strict render preparation, and no main-process
  preprocessing execution.
- `src/services/agentic-generation.service.ts`,
  `agentic-generation-coordinator.service.ts`, `agentic-work-phase.service.ts`,
  `agentic-render-phase.service.ts`, and `agentic-commit.service.ts`: phase
  machine, allowlist, root/model finalization, strict preparation, CAS gate,
  atomic commit, receipt, and compatibility events.
- `src/services/startup-recovery.service.ts`, `src/main.ts`, and
  `getAgenticRuntimeMode()` in `src/services/turn-execution.service.ts`:
  pre-`Bun.serve` reconciliation, fail-closed readiness, and the rollback
  switch.


## WORK Engine public contract

### Runtime mode, provenance, and repair

`POST /api/v1/generate/effective-runtime` returns the authenticated
`EffectiveRuntimePublicResponseV1`. Its closed public fields are
`version`, `chatId`, `target`, safe `connection` and `preset` projections,
`agentsEnabled`, `allowedModes`, `defaultMode`, `requestedMode`,
`effectiveMode`, required `inspection`, nullable `responseOmission`,
`runtimePolicy`, `chatOverride`, `capabilityReadiness`, `repairCodes`,
`runtimeDecisionToken`, and `runtimeDecisionExpiresAt`. `inspection` is
present for both modes; `responseOmission` carries Response-only omission
evidence and is `null` for Agentic. The response never returns a credential,
normalized endpoint, or trust-domain fingerprint.

The effective mode has one explicit precedence chain:

1. authenticated one-turn selection supplied as `mode` for this request;
2. the ready durable chat override;
3. the reviewed preset default;
4. the Response fallback.

`mode` is the authenticated one-turn request field. `transientSelection` and
`transient_selection` are internal runtime-policy fields and are rejected on
the public effective-runtime request; clients must not send them.

The returned `runtimePolicy` records both decision value and provenance:

```ts
{
  version: 1,
  authoredValue: 'response' | 'agentic',
  effectiveValue: 'response' | 'agentic',
  source:
    | 'authenticated_one_turn'
    | 'durable_chat_override'
    | 'reviewed_preset_default'
    | 'response_fallback'
    | 'host_cap'
    | 'host_rejected',
  scope: 'turn' | 'chat' | 'preset' | 'fallback' | 'host',
  cap: { authority: 'host', allowedModes: ('response' | 'agentic')[], reasonCode: string | null },
  availability: {
    state: 'available' | 'unavailable' | 'stale' | 'invalid' | 'denied' | 'omitted',
    reasonCode: string | null,
  },
  presetRevision: string | number | null,
  transientSelection: { mode, turnFence, authenticated: true } | null,
  durableChatOverride: { mode, revision, state, reviewCode, acknowledged } | null,
  repairAcknowledgement: {
    state: 'not_required' | 'required' | 'acknowledged',
    presetRevision: string | number | null,
    reasonCode: string | null,
    acknowledgedAt: number | null,
  },
  nextTurnOnly: true,
}
```

`PUT /api/v1/chats/:id/agent-mode` accepts exactly
`{ mode: 'response' | 'agentic', expectedRevision: number }`; `DELETE` on
the same path accepts exactly `{ expectedRevision: number }`. Both return
`{ chatId, mode, revision, state, appliesTo: 'next_turn' }`. A missing
precondition is `428 AGENT_CHAT_MODE_REVISION_REQUIRED`; a stale CAS is
`409 AGENT_CHAT_MODE_REVISION_CONFLICT`. A mode write never changes the
already-running Turn Session.

`POST /api/v1/presets/:id/agent-runtime/repair-acknowledgement` accepts
exactly `{ reasonCode: string, expectedPresetRevision: string | number }`.
Its response is the persisted `{ presetId, presetRevision, reasonCode,
acknowledgedAt, revision, scope: 'repair/review', state: 'acknowledged' }`.
The record acknowledges owner review for one preset revision; it does not
choose a mode or turn a missing capability into an available one.

An Agentic request consumes the opaque decision token once. A stale target,
revision, binding, capability, context authorization, isolate/publication
gate, or kill switch fails closed. `effectiveMode: 'response'` is an
available explicit escape reported by preflight, not permission for an
Agentic request to downgrade. The caller must submit `mode: 'response'` for
that escape.

### Explicit assembly surface and Loom policy

Prompt assembly has one required host-authenticated surface:
`AssemblySurfaceV1 = 'RESPONSE' | 'WORK'`. The frozen
`GenerationAssemblySnapshotV1` and the returned `AssemblyPlanV1` both carry
`assemblySurface`; the compiler never infers it from configuration. The
direct `raw`, `quiet`, and `batch` helpers remain provider helpers and do
not run this assembly contract.

The canonical authored policy is
`AgentConfigV2.runtimePolicy.loomPolicy`, a `LoomPolicyBucketsV1` with
exactly `workPolicy`, `workspaceUsage`, `completionCriteria`, and
`renderPolicy` arrays. Loom owns only existing prompt blocks plus
**Phased Instructions**; it does not create a second context authority. Every
entry carries source provenance
`{ kind: 'loom_block', blockId, presetRevision, blockRevision, promptOrder }`,
one fixed `destination` (`root_work`, `completion_handoff`, or `render`),
one fixed `checkpoint` (`ASSEMBLE`, `WORK`, `PREPARE_COMMIT`, or `RENDER`),
`required`, `visibility: 'work_only'`, and an optional typed `condition`.
Conditions evaluate fail-closed only against the immutable snapshot at the
owning checkpoint and remain fixed for that checkpoint.

Routing is not configurable at runtime: `workPolicy` and `workspaceUsage`
route to `root_work`/`WORK` (root **WORK** / **WORK**), `completionCriteria`
routes to `completion_handoff`/`PREPARE_COMMIT`, and `renderPolicy` routes to
`render`/`RENDER` (tools-disabled **RENDER** / **RENDER**). The plan retains
the canonical `loomPolicy` beside its materialized message arrays and source
blocks. Custom phases are bounded and current-phase-only: later phase
instructions are not materialized early. Each phase may declare explicit
`childInstructionSubsets`; a child receives only its admitted subset, never
the root phase instructions or another child’s subset.

Response assembly excludes all `work_only` entries and exposes a typed
`responseOmission`; no WORK policy, private work note, or WORK child result
is copied into a Response. This omission is narrow: established Response
assembly preserves the conversation and ordinary native World Book and
Databank retrieval, while [Context Filters](../../../user-docs/docs/presets/context-filters.md) and unrelated native Loom content [packs](../../../user-docs/docs/packs/index.md) remain outside Loom.
The retired **Context Pack**, **Context Library**, and **Progressive Context** surfaces are
not supported.

The unified owner inspection projection combines `LoomPromptInspectionV1` with prompt evidence. It explains routes and order, roles, conditions, exact source identities and revisions, hashes when recorded, one effective copy for each destination-level overlap while retaining every role/reason/overlap outcome, omissions, custom-phase and explicit child-subset receipts, accepted WORK-to-RENDER crossings, and tools/delegation. If a layer is unavailable or not recorded, inspection marks it unavailable; it is never inferred.

Each `AgentPromptEvidenceV1` record carries a required canonical zero-based `promptOrder`. Cognition evidence takes `sourceId`, `sourceRevision`, and `promptOrder` from the frozen Loom source's `blockId`, `blockRevision`, and `promptOrder`; other assembly sources use their provenance source coordinate. Bounded deterministic prompt record IDs hash lifecycle, destination, source kind, exact occurrence, cognition entry/bucket, role, content digest, local index, and the retained evidence payload so separate buckets, lifecycles, and conflicting payloads remain distinct durable records. Loom role correlation uses the exact `sourceId + promptOrder + sourceRevision` occurrence only when the prompt section is fully available; missing, malformed, truncated, mismatched, or conflicting evidence remains unavailable rather than borrowing a sibling or retained prefix.

The Loom inspection shape is `{ version, surface, checkpoint, items, effectiveEntryIds, responseOmission? }`; the public wire fields remain `inspection` and `responseOmission`. Each item identifies its bucket, destination, checkpoint, exact Loom source, optional typed condition and checkpoint result, requiredness, effective text, and a typed outcome: `included`, `skipped`, `rejected`, `omitted`, or `deduplicated`. On a Response surface, every omitted item carries the `response_mode` outcome and `responseOmission` explains the `work_only` boundary. This is inspection evidence, not authority to edit the preset.

The outcome reasons are closed. `skipped` uses `checkpoint_not_reached | condition_not_met | stale_source`; `rejected` uses `invalid_source | stale_source | required_source_unavailable`; `omitted` uses `response_mode | destination_unavailable | not_work_surface`; and `deduplicated` carries `keptEntryId` and the retained destination. `included` carries `effectiveIndex`.

World Books and Databank content is not a Loom inspection entry or pinned external source. Their native evidence reports the source identity and content hash actually used when available; Loom does not own, pin, or repair it.

### WORK tools, delegation, and receipts

The strict WORK catalog is closed:

`complete_turn`;
`workspace_read_section`, `workspace_read_page`,
`workspace_create_task`, `workspace_update_assigned_progress`,
`workspace_submit_child_result`, `workspace_submit_root_result`,
`workspace_accept_submission`,
`workspace_record_finding`, `workspace_record_decision`,
`workspace_record_question`, `workspace_attach_artifact`,
`workspace_propose_publication`;

`lore_list_books`, `lore_get_book`, `lore_list_entries`, `lore_get_entry`,
`lore_search_entries`, `chat_search_history`.

`agent_delegate` is a root-only dispatch capability. Its closed arguments are
`profile_id`, `task_id`, `task`, and optional narrowed `tool_ids`. Admission
checks the reviewed profile, open task inventory, exact assignment
acknowledgement, depth-one frame limit, and child output bounds. Root frames
alone may call `complete_turn` (with bounded `summary`, `unresolvedIds`, and
optional `renderGuidance`).

`complete_turn` must be the only call in its tool-call batch. Before the final custom phase, a valid call after the current exit predicate is satisfied advances the machine and returns `{ status: "phase_advanced", toolName: "complete_turn", workspaceRevision, phaseId }`; it does not accept final completion. Only when the final custom phase's exit is satisfied—or when no custom phase is active—does that standalone call run the completion fixed point and return `{ status: "accepted", toolName: "complete_turn", workspaceRevision }`.

Root-only workspace operations are `workspace_create_task`,
`workspace_submit_root_result`, and `workspace_accept_submission`. A root
provider may submit a bounded result only for its own unassigned task;
assigned child tasks remain child-confined. A child may use only the read,
assigned-progress, and assigned-submission operations granted to its frame; all
other workspace operations require an explicit host grant.

`workspace_read_section` and `workspace_read_page` accept exactly `objective`, `constraints`, `tasks`, `records`, `submissions`, `artifacts`, and `summary`. Root-created tasks are always optional, so the root-facing `workspace_create_task` contract does not accept a `required` argument. Host/cognition-authored task templates retain their requiredness, and malformed/manual attempts to create a required root task fail closed.

When a dynamically assigned child fails, is cancelled, or times out, the host
settles that exact task/frame pair as `failed` or `cancelled` before exposing
the next root checkpoint. Optional failures remain nonblocking. A required
failure is retained as the original terminal code while configured recovery
phases may record findings/decisions and complete; only after the bounded
recovery path exits or exhausts does WORK return the required failure.

Children receive only granted core tools and host-assigned workspace
operations. Workspace tool calls carry host-authenticated actor/frame
context and an expected revision internally. Their result envelope is
`AgenticWorkspaceResultEnvelopeV1 { result, cognition? }`; `cognition` is
private host CAS metadata. A completion acceptance carries bounded completion
data, the accepted workspace revision, and the deterministic workspace context
projection. Activity/inspection receipts expose identifiers, status, counts,
and bounded error codes—not arguments, result bodies, or provider carriers.

The host assignment acknowledgement is bounded:

```ts
{
  accepted: boolean,
  workspaceRevision: number,
  assignments: { taskId: string, frameId: string }[],
}
```

Owner inspection child metadata is:

```ts
{
  childId: string,
  profileId: string,
  slotIndex: number,
  required: boolean,
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
  outputBytes: number,
  errorCode?: string,
}
```

WORK observations remain metadata-only:
`{ sequence, callId, correlationId, toolName, status, code?, resultBytes }`.
Neither observation nor child metadata contains arguments, result bodies, or
provider carriers.

### Cortex and Council boundaries

Cortex and Council are separate, host-admitted advisory sidecars at the
`WORK` checkpoint. Neither is a public REST route, a generic WORK tool, a
child-authority source, or a commit authority. Their values are bounded
snapshots/advice and their receipts are owner-inspection evidence with
`canonical: false`; the final Response never contains the private sidecar
record.

A Cortex read uses a host-owned immutable snapshot identified by owner,
attempt, chat/target scope, `snapshotId`, and opaque `revision`. It returns
either `{ kind: 'accepted', value, receipt }` or an optional
`{ kind: 'omission', omission, receipt }`. A required read fails the WORK
operation instead of becoming an optional omission. `AgentCortexReceiptV1`
records `requestId`, `attemptId`, `checkpoint: 'WORK'`, source/current
revisions, scope, requiredness, timing, state
(`accepted | omitted | failed | cancelled`), result digest/count,
correlation, reason, and omission.

Council admission is host-owned and freezes settings, sidecar settings,
member/tool selections, connection revision, requiredness, and correlation.
`AgentCouncilReceiptV1` records `requestId`, `checkpoint: 'WORK'`,
requiredness, timing, state, member count, advice digest, correlation,
reason, and `canonical: false`. A successful Council result is advisory
advice only. Optional failure is omitted; required failure is a failed
WORK operation. Neither sidecar can add tools, spawn children, widen the
frozen target, or write the canonical message.

### Public errors, usage, and owner reads

Every Agent Run route failure uses
`{ version: 2, error: AgentRunPublicErrorV2 }`. The error contains
`code`, `category`, `summaryCode`, `recoveryEligible`, `recoveryAction`,
`target`, `workPhase`, `workStatus`, `workOutcome`, `reason`,
`omissionCount`, and `inspectionAttemptId`. `summaryCode` is a stable
localization key; it is not provider text. `recoveryAction` is host-owned and
is one of `retry`, `repair`, `reselect`, `use_response`, `resync`, or
`none`.

`AgentRunPublicV2` is status-only and includes IDs, target, phase/status/
outcome, attempt lineage, revision/sequence/timestamps, bounded activity,
aggregate usage, omission markers, recovery fields, and (when applicable)
the committed terminal handoff. Aggregate usage is
`{ inputTokens, outputTokens, totalTokens, toolCalls, childInvocations }`.
Owner inspection detail adds layered usage totals/evidence for
`root | child | provider | tool | cortex | council`, with source,
correlation, evidence IDs, and a `canonical` flag, plus causal error
authority/source/scope/cap-gate detail. Public runs never expose those
private layers.

Canonical authenticated reads are:

| Method | Endpoint | Result |
|---|---|---|
| `GET` | `/api/v1/agent-runs/changes/:chatId` | Cursor delta/full-resync `AgentRunChangesV2` |
| `GET` | `/api/v1/agent-runs/status/:turnId` | Exact `AgentRunPublicV2` |
| `GET` | `/api/v1/agent-runs/inspection?chatId=...` | Owner inspection summaries |
| `GET` | `/api/v1/agent-runs/:attemptId/inspection` | Full owner inspection detail |
| `POST` | `/api/v1/agent-runs/:attemptId/retry` | Strict retry admission (`202` only after durable admission) |
| `GET` | `/api/v1/agent-runs/:turnId/workspace` | Redacted Turn Session workspace index |
| `GET` | `/api/v1/agent-runs/:turnId/workspace/:section` | Redacted page for `objective`, `tasks`, `records`, `submissions`, or `artifacts` |
| `POST` | `/api/v1/agent-runs/:turnId/stop` | `{ status: 'accepted' | 'too_late' | 'terminal', ... }` |

All reads are owner-scoped and re-check target/Turn Session identity. An
expired cursor receives one bounded full-resync page and a fresh cursor;
missing, foreign, or no-longer-retained data is a non-disclosing `404`.
Inspection retention is layered and bounded; omission markers identify what
could not be retained or read.

The **Persistent Workspace** is a separate stable, structured owner record.
Its `/api/v1/agent-runs/workspace...` routes use authenticated owner/chat
scope and revision CAS; body-supplied owner, chat, actor, or publication
authority is never trusted. It can outlive a Turn Session or detach from a
deleted chat. Publication stores an independent bounded copy with source
digest/provenance; it is not a canonical chat message and does not grant
WORK authority. The retained-session route is bounded end-to-end with the
shared `limit`/`offset` pagination contract (`limit` default `50`, maximum
`1000`) and returns `{ data, total, limit, offset }`.

## Reasoning / extended thinking

Most modern frontier models expose a "thinking" knob — Anthropic's `thinking` block, Google's `thinkingConfig`, DeepSeek's `reasoning_effort`, the OpenAI-compatible `reasoning.effort`, and so on. Lumiverse wraps that surface in a single high-level shape so extensions don't have to encode each provider's quirks.

By default, every generation request inherits the **resolved user reasoning settings**:

1. If the request resolves a connection (`connection_id`, or `quiet` resolving the user's active connection) and that connection has a binding (`metadata.reasoningBindings`), the binding wins.
2. Otherwise the user's global `reasoningSettings` is applied.
3. The host translates the resolved `{ apiReasoning, reasoningEffort, thinkingDisplay }` into the provider-specific parameters before dispatching the request.

You can inspect what a connection is bound to via [`spindle.connections.get()`](#connection-profiles) — the `reasoning_bindings` field is the parsed, typed view.

### Per-request override

Pass `reasoning` on any `generate.*` call to bypass the inherited settings for that single request:

```ts
// Force thinking off — cheaper one-shot summarization on a connection
// that normally has high-effort reasoning enabled.
await spindle.generate.raw({
  messages: [{ role: 'user', content: 'TL;DR this paragraph.' }],
  connection_id: connId,
  reasoning: { source: 'off' },
})

// Crank the effort up just for this one call.
await spindle.generate.quiet({
  messages,
  reasoning: { source: 'custom', apiReasoning: true, effort: 'max' },
})

// Anthropic — opt into summarised thinking blocks for this call.
await spindle.generate.raw({
  messages,
  connection_id: anthropicConnId,
  reasoning: {
    source: 'custom',
    apiReasoning: true,
    effort: 'high',
    thinkingDisplay: 'summarized',
  },
})

// Echo the connection's bound settings back, then dial effort up one tier.
const conn = await spindle.connections.get(connId)
const bound = conn?.reasoning_bindings?.settings
if (bound?.apiReasoning) {
  await spindle.generate.rawStream({
    messages,
    connection_id: connId,
    reasoning: { source: 'custom', apiReasoning: true, effort: 'max' },
  })
}
```

### GenerationReasoningOverrideDTO

| Field | Type | Description |
|---|---|---|
| `source` | `"inherit" \| "off" \| "custom"` | Default `"inherit"` — apply the connection binding then fall back to the user setting. `"off"` strips every provider reasoning field and applies the off-switch unconditionally. `"custom"` uses the explicit fields below. |
| `apiReasoning` | `boolean` | Used when `source === "custom"`. Defaults to `true`. Set `false` to mean the same thing as `source: "off"`. |
| `effort` | `ReasoningEffortDTO` | Used when `source === "custom"`. One of `"auto" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "max" \| "xhigh"`. Defaults to `"auto"`. |
| `thinkingDisplay` | `ThinkingDisplayDTO` | Anthropic-only. One of `"auto" \| "summarized" \| "omitted"`. Maps to `thinking.display`. Defaults to `"auto"` (model-specific default). |

### Precedence

Raw values supplied in `parameters` still take precedence at the field level. The override only fills in fields that aren't already set on the request — the same behaviour as the inherited settings. The single exception is `source: "off"` (or `source: "custom", apiReasoning: false`), which unconditionally strips `thinking` / `thinkingConfig` / `reasoning` / `reasoning_effort` and applies the provider's documented off-switch.

That means an extension can opt out of host translation entirely by writing the provider-specific shape into `parameters` directly — `reasoning` is only a convenience layer.

### Provider mapping

| Provider | `apiReasoning: true` produces | Effort handling |
|---|---|---|
| Anthropic (Claude 4.6–4.8 and Claude 5 adaptive) | `thinking: { type: "adaptive" }` + `output_config.effort` | `low \| medium \| high \| max` (+ `xhigh` on Opus 4.7) |
| Anthropic (legacy) | `thinking: { type: "enabled", budget_tokens: N }` | `low=2048, medium=8192, high=16384, max=32768` |
| Google (Gemini / Vertex) | `thinkingConfig: { thinkingLevel, includeThoughts: true }` | `minimal \| low \| medium \| high` |
| DeepSeek | `thinking: { type: "enabled" }` + `reasoning_effort` | `low/medium/high → "high"`, `max/xhigh → "max"` |
| OpenRouter | `reasoning: { effort }` | `none \| minimal \| low \| medium \| high \| xhigh` |
| NanoGPT | `reasoning: { effort }` (object form preserves `exclude` / `delta_field`) | `none \| minimal \| low \| medium \| high` |
| Moonshot (Kimi K3) | `reasoning_effort: "max"` | Currently only `"max"` is supported |
| Moonshot (Kimi K2.7 Code) | `thinking: { type: "enabled", keep: "all" }` | Thinking is always on; preserved-thinking config |
| Moonshot (Kimi K2.6 / K2.5) | `thinking: { type: "enabled" }` | Toggle-only for these model families |
| Z.AI (GLM-5.3 / GLM-5.3-Flash) | `thinking: { type: "enabled" }` + `reasoning_effort` | Forced thinking; `low \| high \| max` |
| Z.AI (older GLM-5.x) | `thinking: { type: "enabled" }` + `reasoning_effort` | `max \| xhigh \| high \| medium \| low \| minimal \| none` (API maps to max/high/none) |
| Z.AI (GLM-4.x) | `thinking: { type: "enabled" }` | Toggle-only — `reasoning_effort` is not supported |
| Generic OpenAI-compatible | `reasoning: { effort }` | Passed verbatim |

When `apiReasoning: false` the host writes the provider's documented "no extended thinking" shape — `thinking: { type: "disabled" }` for Anthropic, DeepSeek, and Z.AI models that support disabling it; `thinking: { type: "enabled" }` with `reasoning_effort: "low"` for the forced-thinking GLM-5.3 family; `reasoning: { exclude: true }` for NanoGPT; `thinking: { type: "disabled" }` for Moonshot K2.6/K2.5; omission for Moonshot K3/K2.7-code (these models always think).

---

## Cancellation

Every generation method (`raw`, `quiet`, `batch`, `rawStream`, `quietStream`) accepts an optional `AbortSignal`. When the signal fires, the upstream LLM HTTP request is torn down and the call rejects with a standard `DOMException` whose `.name === "AbortError"`.

The signal is consumed inside the extension worker and never crosses the wire. When abort fires, the worker posts an internal `cancel_generation` message to the host, which calls `controller.abort()` on the `AbortController` it created for the upstream provider call.

```ts
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 5_000)

try {
  const result = await spindle.generate.raw({
    messages: [{ role: 'user', content: 'Write a long essay…' }],
    signal: controller.signal,
  })
  // result: { content, finish_reason, usage }
} catch (err) {
  if (err.name === 'AbortError') {
    spindle.log.info('Generation cancelled')
  } else {
    throw err
  }
} finally {
  clearTimeout(timer)
}
```

Compose with `AbortSignal.timeout()` and `AbortSignal.any()` for richer cancellation semantics:

```ts
const userController = new AbortController()
const signal = AbortSignal.any([
  userController.signal,
  AbortSignal.timeout(30_000),
])

await spindle.generate.quiet({ messages, signal })
```

For `batch`, the same signal is threaded into every sub-request. Aborting mid-flight cancels the in-flight call and prevents any not-yet-started sequential calls from beginning. With `concurrent: true`, every parallel call sees the abort.

---

## Streaming

Stream tokens incrementally as the LLM emits them, instead of waiting for the full response. `rawStream` and `quietStream` mirror their non-streaming counterparts but return an `AsyncGenerator<StreamChunkDTO>` that you can iterate with `for await`.

The generator yields one or more `token` / `reasoning` chunks and exactly one terminal `done` chunk carrying the aggregated response. If the call fails or is aborted, the generator throws instead of yielding `done`.

### `spindle.generate.rawStream(input)`

```ts
let acc = ''
for await (const chunk of spindle.generate.rawStream({
  provider: 'openai',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Tell me a story.' }],
})) {
  if (chunk.type === 'token') {
    acc += chunk.token
    process.stdout.write(chunk.token)
  } else if (chunk.type === 'reasoning') {
    spindle.log.info(`[thinking] ${chunk.token}`)
  } else if (chunk.type === 'done') {
    spindle.log.info(`Final usage: ${chunk.usage?.total_tokens} tokens`)
    spindle.log.info(`finish_reason: ${chunk.finish_reason}`)
  }
}
```

### `spindle.generate.quietStream(input)`

Same semantics as `rawStream`, but uses the user's active connection profile and preset parameters (no `provider`/`model` required).

```ts
for await (const chunk of spindle.generate.quietStream({
  messages: [{ role: 'user', content: 'Hello!' }],
})) {
  if (chunk.type === 'token') process.stdout.write(chunk.token)
}
```

### Cancelling a stream

`rawStream` / `quietStream` accept the same `AbortSignal` as the non-streaming methods. The generator throws `AbortError` on abort. You can also break out of the `for await` loop early — the generator's cleanup posts a cancel message to tear down the upstream request.

```ts
const controller = new AbortController()
setTimeout(() => controller.abort(), 2_000)

try {
  for await (const chunk of spindle.generate.rawStream({
    messages: [{ role: 'user', content: 'Long answer…' }],
    signal: controller.signal,
  })) {
    if (chunk.type === 'token') process.stdout.write(chunk.token)
  }
} catch (err) {
  if (err.name === 'AbortError') spindle.log.info('Stream cancelled')
  else throw err
}

// Or break early — same effect, no AbortController needed:
for await (const chunk of spindle.generate.quietStream({ messages })) {
  if (chunk.type === 'token' && shouldStop()) break // host receives cancel
}
```

### StreamChunkDTO

A discriminated union with three variants:

| `type` | Fields | Description |
|---|---|---|
| `"token"` | `token: string` | Incremental content token. |
| `"reasoning"` | `token: string` | Incremental chain-of-thought token (provider-dependent). |
| `"done"` | `content: string`, `reasoning?: string`, `finish_reason: string`, `tool_calls?: ToolCallDTO[]`, `usage?: { prompt_tokens, completion_tokens, total_tokens }` | Terminal chunk — emitted exactly once on success. Carries the aggregated response so you don't need to accumulate manually if you don't want to. |

!!! note "No `batchStream`"
    Batch is just a wrapper around N raw calls. If you want parallel streamed responses, run `Promise.all([rawStream(a), rawStream(b)])` and consume each iterator however you like.

---

## Assembly-only block graphs

`spindle.assemble()` runs native Loom assembly for an extension-supplied block
graph without calling an LLM and without entering the context-handler or
pre-generation interceptor pipelines. It is safe to call from inside a
`registerInterceptor` handler.

```ts
const assembled = await spindle.assemble({
  chatId,
  blocks: thread.blocks,
  connectionId: thread.connectionId,
  promptVariables: thread.promptVariables,
})

const result = await spindle.generate.quiet({
  messages: assembled.messages,
  connection_id: thread.connectionId,
})
```

Assembly uses the supplied chat for history, character/persona macros, attached
world info, memories, and marker placement. The supplied blocks replace the
saved preset's block graph and are not persisted. Preset-profile block overrides
are not applied. Macro resolution is non-committing.

| Field | Type | Description |
|---|---|---|
| `blocks` | `PromptBlockDTO[]` | **Required.** Arbitrary Loom block graph (maximum 256 blocks / 1 MB encoded). |
| `chatId` | `string` | **Required.** Chat supplying native assembly context. |
| `connectionId` | `string` | Optional connection-aware macro context. |
| `personaId` | `string` | Optional persona override. |
| `generationType` | `string` | Optional injection-trigger context; defaults to `"normal"`. |
| `promptVariables` | `PromptVariableValuesDTO` | Optional values keyed by block id and variable name. |
| `signal` | `AbortSignal` | Optional cancellation signal. |

The result contains the assembled `messages` and native `breakdown`. This API
requires the `generation` permission because the result may contain chat,
persona, memory, and world-info content.

## Dry Run (Prompt Assembly)

!!! warning "Agents & Tools"
    This Dry Run result contract applies only when the effective preset has no executable Agents & Tools intrinsic (for example, the feature is absent or disabled). An executable intrinsic fails with `AgentDryRunUnsupportedError` before child/runtime/provider work; Dry Run never exposes feature tools or returns a partially assembled result.

When the effective preset contains no executable Agents & Tools intrinsic, run the full prompt assembly pipeline — macros, world info, context filters, memory retrieval, and token counting — without actually calling the LLM. This is useful for prompt debugging, token budget analysis, and previewing what the model will see.


### `spindle.generate.dryRun(input, userId?)`

```ts
const result = await spindle.generate.dryRun({
  chatId: 'chat-id',
}, userId) // userId required for operator-scoped extensions

spindle.log.info(`Provider: ${result.provider}, Model: ${result.model}`)
spindle.log.info(`Assembled ${result.messages.length} messages`)
spindle.log.info(`Breakdown: ${result.breakdown.length} blocks`)

if (result.tokenCount) {
  spindle.log.info(`Total tokens: ${result.tokenCount.total_tokens}`)
}

if (result.worldInfoStats) {
  spindle.log.info(`WI entries activated: ${result.worldInfoStats.activatedAfterBudget}`)
}

if (result.memoryStats?.enabled) {
  spindle.log.info(`Memory chunks retrieved: ${result.memoryStats.chunksRetrieved}`)
}
```

You can optionally override the connection, persona, preset, or generation type:

```ts
const result = await spindle.generate.dryRun({
  chatId: 'chat-id',
  connectionId: 'specific-connection',   // default: user's default connection
  personaId: 'specific-persona',         // default: user's active/default persona
  presetId: 'specific-preset',           // default: connection's linked preset
  generationType: 'continue',            // default: 'normal'
  parameters: { temperature: 0.8 },      // override sampler params
}, userId)
```

### DryRunRequestDTO

| Field | Type | Description |
|---|---|---|
| `chatId` | `string` | **Required.** The chat to assemble the prompt for. |
| `connectionId` | `string` | Optional. Use a specific connection profile. |
| `personaId` | `string` | Optional. Use a specific persona. |
| `presetId` | `string` | Optional. Use a specific preset. |
| `generationType` | `string` | Optional. One of `"normal"`, `"continue"`, `"regenerate"`, `"swipe"`, `"impersonate"`. |
| `parameters` | `Record<string, unknown>` | Optional. Override sampler parameters. |

`dryRun` also accepts a second argument:

| Argument | Type | Description |
|---|---|---|
| `userId` | `string` | **Required for operator-scoped extensions.** The user ID to scope the dry run to. For user-scoped extensions, this is inferred automatically and can be omitted. |

### DryRunResultDTO

| Field | Type | Description |
|---|---|---|
| `messages` | `LlmMessageDTO[]` | The fully assembled message array that would be sent to the LLM when no executable Agents & Tools intrinsic is present. |
| `breakdown` | `AssemblyBreakdownEntryDTO[]` | Ordered list of prompt blocks showing how the prompt was built. |
| `parameters` | `Record<string, unknown>` | Final merged sampler parameters. |
| `model` | `string` | The model that would be used. |
| `provider` | `string` | The provider that would be used. |
| `tokenCount` | `DryRunTokenCountDTO` | Optional. Per-block token counts (if a tokenizer is available). |
| `worldInfoStats` | `ActivationStatsDTO` | Optional. World info activation statistics. |
| `memoryStats` | `MemoryStatsDTO` | Optional. Long-term memory retrieval statistics. |

### AssemblyBreakdownEntryDTO

Each entry represents one block in the assembled prompt:

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Block type: `"block"`, `"chat_history"`, `"world_info"`, `"authors_note"`, `"utility"`, `"long_term_memory"`, `"separator"`, `"append"`, `"sidecar"`, `"extension"`. |
| `name` | `string` | Human-readable block name. |
| `role` | `string` | Message role (`"system"`, `"user"`, `"assistant"`). |
| `content` | `string` | The resolved text content. |
| `blockId` | `string` | Preset block ID (if from a preset block). |
| `extensionId` | `string` | Present for interceptor-injected breakdown blocks. Resolved from the installed extension manifest. |
| `extensionName` | `string` | Human-readable extension attribution for interceptor-injected breakdown blocks. |

When an interceptor returns `breakdown: [{ messageIndex, name? }]`, the host turns those referenced messages into `type: "extension"` breakdown entries. This means retrieval or prompt-engineering extensions can expose their injected context in both dry-run results and persisted prompt breakdown snapshots without having to parse or diff the final prompt themselves.

### ActivationStatsDTO

| Field | Type | Description |
|---|---|---|
| `totalCandidates` | `number` | Total WI entries considered. |
| `activatedBeforeBudget` | `number` | Entries that matched before budget enforcement. |
| `activatedAfterBudget` | `number` | Entries included after budget enforcement. |
| `evictedByBudget` | `number` | Entries dropped due to budget limits. |
| `evictedByMinPriority` | `number` | Entries dropped due to minimum priority threshold. |
| `estimatedTokens` | `number` | Approximate total WI tokens (chars/4). |
| `recursionPassesUsed` | `number` | Number of keyword-chaining recursion passes. |

### MemoryStatsDTO

| Field | Type | Description |
|---|---|---|
| `enabled` | `boolean` | Whether long-term memory is active. |
| `chunksRetrieved` | `number` | Number of memory chunks included. |
| `chunksAvailable` | `number` | Total chunks in the vector store. |
| `chunksPending` | `number` | Chunks awaiting vectorization. |
| `injectionMethod` | `string` | How memories were injected: `"macro"`, `"fallback"`, or `"disabled"`. |
| `retrievalMode` | `string?` | How chunks were retrieved: `"vector"` (real vector/hybrid search) or `"recency"` (fallback, e.g. the query embedding failed). `retrievedChunks[].score` is `null` for recency/keyword-only hits. |
| `queryPreview` | `string` | Truncated query text used for vector search. |
| `settingsSource` | `string` | Whether settings came from `"global"` or `"per_chat"` overrides. |

!!! tip
    When no executable Agents & Tools intrinsic is present, Dry Run mirrors the exact assembly pipeline used during real generation (macros, world info, context filters, memory) but skips the Council execution and LLM call. An executable intrinsic instead returns `AgentDryRunUnsupportedError`.

---

## Structured Output

Some providers support native structured output, ensuring the LLM response conforms to a JSON schema. Pass provider-specific parameters via the `parameters` field.

### Google Gemini

Use `responseMimeType` and `responseSchema` to request structured JSON output:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age from: "Alice is 25 years old."' },
  ],
  parameters: {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name', 'age'],
    },
  },
  connection_id: 'my-gemini-connection',
})
// result.content: '{"name": "Alice", "age": 25}'
```

`responseJsonSchema` is accepted as an alias for `responseSchema`.

### OpenAI-compatible

Use the standard `response_format` parameter:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age.' },
  ],
  parameters: {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'character_info',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
          },
          required: ['name', 'age'],
        },
      },
    },
  },
  connection_id: 'my-openai-connection',
})
```

### Anthropic

Anthropic uses tool definitions for structured output. Define a tool with the desired output schema and set `tool_choice` to force it:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age.' },
  ],
  parameters: {
    tools: [{
      name: 'extract_info',
      description: 'Extract structured character information',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name', 'age'],
      },
    }],
    tool_choice: { type: 'tool', name: 'extract_info' },
  },
  connection_id: 'my-anthropic-connection',
})
```

!!! tip
    Provider-specific parameters are passed through to the underlying API. Any parameter not explicitly handled by Lumiverse is forwarded directly, so you can use provider-specific features even if they aren't documented here.

---

## Stream Observation

Observe an in-flight LLM generation in real time. `observe()` subscribes to all generation lifecycle events for a specific chat, accumulates streamed content and reasoning tokens automatically, and exposes them through a simple callback API.

### `spindle.generate.observe(chatId)`

Returns a `GenerationObserver` that filters events to the given chat.

```ts
const observer = spindle.generate.observe('chat-uuid')

observer.onStart((info) => {
  spindle.log.info(`Generation started: ${info.model}`)
})

observer.onToken((token) => {
  // Called for every streamed token (content and reasoning)
  if (token.type === 'reasoning') {
    spindle.log.info(`[thinking] ${token.token}`)
  }
})

observer.onEnd((result) => {
  if (result.error) {
    spindle.log.error(`Generation failed: ${result.error}`)
  } else {
    spindle.log.info(`Done — ${observer.content.length} chars`)
  }
  observer.dispose()
})

observer.onStop((result) => {
  spindle.log.info(`Stopped early — partial: ${observer.content.length} chars`)
  observer.dispose()
})
```

At any point during streaming you can read the accumulated state:

```ts
observer.content    // all content tokens concatenated
observer.reasoning  // all reasoning tokens concatenated
observer.generationId  // active generation ID, or null if idle
```

!!! warning "Always call `dispose()`"
    The observer subscribes to four event channels internally. Call `observer.dispose()` when you no longer need it to unsubscribe and free resources.

### GenerationObserver

| Property / Method | Type | Description |
|---|---|---|
| `onStart(handler)` | `(info: GenerationStartedPayloadDTO) => void` | Called when a generation begins on this chat |
| `onToken(handler)` | `(token: StreamTokenPayloadDTO) => void` | Called for each streamed token |
| `onEnd(handler)` | `(result: GenerationEndedPayloadDTO) => void` | Called when the generation completes or errors |
| `onStop(handler)` | `(result: GenerationStoppedPayloadDTO) => void` | Called when the user stops the generation |
| `content` | `string` (readonly) | Accumulated content tokens |
| `reasoning` | `string` (readonly) | Accumulated reasoning/CoT tokens |
| `generationId` | `string \| null` (readonly) | Active generation ID |
| `dispose()` | `() => void` | Unsubscribe from all events |

### GenerationStartedPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Unique generation ID |
| `chatId` | `string` | Chat this generation belongs to |
| `model` | `string` | Model being used |
| `targetMessageId` | `string` | Optional. ID of the message being generated/regenerated |
| `characterId` | `string` | Optional. Target character ID |
| `characterName` | `string` | Optional. Target character name |

### StreamTokenPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Generation this token belongs to |
| `chatId` | `string` | Chat ID |
| `token` | `string` | The text chunk |
| `seq` | `number` | Monotonic sequence number (for deduplication) |
| `type` | `"reasoning"` | Optional. Present for chain-of-thought tokens |

### GenerationEndedPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Generation ID |
| `chatId` | `string` | Chat ID |
| `messageId` | `string` | ID of the saved message (absent on error) |
| `content` | `string` | On success, the final settled content. For a saved target this exactly matches its generated swipe after response regex, formatting healing, and macro resolution; a continue includes the original content and continue postfix. On failure, this is the provisional accumulated stream content. |
| `error` | `string` | Error message (absent on success) |

### GenerationStoppedPayloadDTO

| Field | Type | Description |
|---|---|---|
| `generationId` | `string` | Generation ID |
| `chatId` | `string` | Chat ID |
| `content` | `string` | Provisional stream content accumulated before the stop; it is not a post-processed durable-content snapshot. |
On successful completion, use `result.content` as the authoritative settled
value. The observer's token accumulator can differ when response transforms run.
Failed and stopped terminal payloads intentionally retain the provisional pool
partial instead.

### Raw event subscription

If you need lower-level control (e.g. observing multiple chats, or only specific events), you can subscribe to the generation events directly. These are fully typed when using `lumiverse-spindle-types`:

```ts
const unsub = spindle.on('STREAM_TOKEN_RECEIVED', (payload) => {
  // payload is typed as StreamTokenPayloadDTO
  console.log(payload.token, payload.seq)
})

// Clean up when done
unsub()
```

Available generation events: `GENERATION_STARTED`, `STREAM_TOKEN_RECEIVED`, `GENERATION_ENDED`, `GENERATION_STOPPED`.

---

## Connection Profiles

Extensions with the `generation` permission can discover and inspect the user's connection profiles. This lets you present a UI for selecting which LLM provider/model to use, or programmatically pick the right connection for your use case.

Connection profiles are returned as safe `ConnectionProfileDTO` objects — **API keys are never exposed** (only a `has_api_key` boolean).

### `spindle.connections.list(userId?)`

List all connection profiles available to the user.

```ts
const connections = await spindle.connections.list()
// connections: Array<{ id, name, provider, model, is_default, has_api_key, ... }>

const defaultConn = connections.find(c => c.is_default)
if (defaultConn) {
  const result = await spindle.generate.quiet({
    messages: [{ role: 'user', content: 'Hello' }],
    connection_id: defaultConn.id,
  })
}
```

### `spindle.connections.get(connectionId, userId?)`

Get a single connection profile by ID. Returns `null` if not found.

```ts
const conn = await spindle.connections.get('some-connection-id')
if (conn) {
  spindle.log.info(`Using ${conn.provider} / ${conn.model}`)
}
```

### ConnectionProfileDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique connection profile ID |
| `name` | `string` | Human-readable display name |
| `provider` | `string` | LLM provider identifier (e.g. `"openai"`, `"anthropic"`) |
| `api_url` | `string` | Custom API URL (empty string for default) |
| `model` | `string` | Selected model identifier |
| `preset_id` | `string \| null` | Associated generation preset |
| `is_default` | `boolean` | Whether this is the user's default connection |
| `has_api_key` | `boolean` | Whether an API key is configured (key itself is never exposed) |
| `metadata` | `Record<string, unknown>` | Raw provider-specific metadata bag (Anthropic caching flags, Google thinking budget config, the unparsed `reasoningBindings` blob, etc.) |
| `reasoning_bindings` | `ConnectionReasoningBindingsDTO \| null` | Typed view of the connection's bound reasoning settings, parsed from `metadata.reasoningBindings`. `null` when nothing is bound — generation falls back to the user's global `reasoningSettings` in that case. |
| `created_at` | `number` | Unix timestamp |
| `updated_at` | `number` | Unix timestamp |

### ConnectionReasoningBindingsDTO

When a user binds reasoning settings to a connection from the Connection Manager UI, the snapshot is exposed here so extensions can inspect it without grovelling through `metadata`.

| Field | Type | Description |
|---|---|---|
| `settings` | `ReasoningSettingsDTO` | The bound reasoning snapshot — see below. |
| `promptBias` | `string` | Optional. Bound "Start Reply With" assistant prefill captured alongside the reasoning snapshot. Overrides the user's global `promptBias` for this connection. |

### ReasoningSettingsDTO

| Field | Type | Description |
|---|---|---|
| `apiReasoning` | `boolean` | Master switch — whether the provider should produce thinking output. |
| `reasoningEffort` | `ReasoningEffortDTO` | One of `"auto" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "max" \| "xhigh"`. See the [provider mapping table](#provider-mapping). |
| `thinkingDisplay` | `ThinkingDisplayDTO` | Anthropic-only. `"auto" \| "summarized" \| "omitted"`. |
| `prefix` | `string` | Opening delimiter for the delimited-reasoning parser (e.g. `"<think>\n"`). Only affects parsing, not the outgoing request. |
| `suffix` | `string` | Closing delimiter for the delimited-reasoning parser. |
| `autoParse` | `boolean` | Whether to auto-parse delimited reasoning out of the assistant content stream. |
| `keepInHistory` | `number` | How many recent reasoning blocks to retain in assembled prompt history. `0` strips all, `-1` keeps everything, `N` keeps the last N. |

```ts
const conn = await spindle.connections.get(connId)
if (conn?.reasoning_bindings) {
  const { apiReasoning, reasoningEffort } = conn.reasoning_bindings.settings
  spindle.log.info(
    `Bound: thinking=${apiReasoning}, effort=${reasoningEffort}`,
  )
}
```

!!! note
    For user-scoped extensions, the `userId` parameter is automatically inferred from the extension owner. For operator-scoped extensions, pass `userId` to scope the query to a specific user.
