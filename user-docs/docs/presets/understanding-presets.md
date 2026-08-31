---
title: Understanding Presets
---

# Understanding Presets

This guide explains how presets work conceptually, so you can create and customize them with confidence.

---

## The Prompt Assembly Pipeline

When you send a message, Lumiverse doesn't just forward your chat history to the AI. It assembles a structured **prompt** from multiple sources:

```
┌─────────────────────────────┐
│  Preset Blocks (in order)   │
│  ├── System Prompt          │
│  ├── Character Description  │
│  ├── Personality            │
│  ├── Scenario               │
│  ├── Persona                │
│  ├── World Info (before)    │
│  ├── Chat History           │
│  ├── World Info (after)     │
│  ├── Author's Note          │
│  └── Custom Blocks...       │
├─────────────────────────────┤
│  Sampler Parameters         │
│  (temperature, top_p, etc.) │
└─────────────────────────────┘
```

Each block in the preset can be enabled/disabled, reordered, and customized. This gives you granular control over every part of the prompt.

---

## Preset Components

### Prompt Order (Blocks)

The `prompt_order` is a list of blocks that defines what goes into the prompt and in what order. Each block has:

- **Name** — What this block is called
- **Content** — The text or macro that gets inserted
- **Role** — Whether it's a `system`, `user`, or `assistant` message
- **Enabled** — Whether this block is active
- **Position** — Where it appears relative to the chat history

### Prompts (Named Text Blocks)

The `prompts` map stores named text content used by the preset — things like the main system prompt, continuation nudges, and impersonation instructions.

### Parameters

Sampler settings that control *how* the AI generates (creativity, randomness, length).

### Metadata

Additional configuration like completion settings, sampler overrides, and behavioral flags.

---

## How Blocks Become a Prompt

During assembly, Lumiverse walks through the block list in order:

1. **Marker blocks** (like `char_description`, `scenario`, `persona`) are replaced with the corresponding character/persona data
2. **Content blocks** have their text run through the macro resolver (replacing `{{char}}`, `{{user}}`, etc.)
3. **World Info blocks** are filled with activated lorebook entries
4. **Chat history** inserts all the conversation messages
5. **Special blocks** (Author's Note, continuation nudges) are injected at configured depths

The result is a complete, ordered list of messages sent to the AI.

---

## Macros in Presets

Blocks can contain **macros** — template variables that get replaced with dynamic content. For example:

```
You are {{char}}, a {{personality}} character in the following scenario:
{{scenario}}

The user's name is {{user}}.
{{persona}}
```

This becomes:

```
You are Aria, a curious and adventurous character in the following scenario:
A bustling market square in a medieval fantasy city...

The user's name is Alex.
Alex is a 28-year-old freelance photographer...
```

See the [Macros guide](../customization/macros.md) for a complete reference.

## Agents & Tools and Agentic Runtime

**Agents & Tools** is an opt-in preset capability. It authorizes reusable child-agent profiles and a host-owned set of bounded retrieval tools. The preset editor now exposes these settings in one shared **Agentic Runtime** tab. Nothing runs merely because a preset contains the configuration: the configuration must be enabled, reviewed where necessary, and saved.

Lumiverse has two explicit generation modes:

- **Response** uses the established generation pipeline. It remains the compatibility path for ordinary prompts, Council, multiplayer, extensions, and any turn that does not opt into the closed Agentic runtime. Configured child prompt blocks and core Agents & Tools behavior can still run in Response mode; this does not include Loom Phased Instructions.
- **Agentic** is a strict, opt-in single-turn runtime. One Turn Execution owns one attempt made of ordered Work Segments. It freezes the target, concrete provider choice, prompt inputs, capabilities, context, and readiness inputs before work begins. Each Work Segment receives a fresh projection of the root objective, current phase instructions and completion criteria, accepted workspace state, open required work, budgets, and the previous bounded handoff. Provider transcripts and continuation carriers retire at each boundary; later segments never inherit them. Only durable host-accepted workspace state and bounded handoff metadata cross segments. Final rendering and the chat write occur once, after WORK completes, and commit atomically. Agentic never silently becomes Response if a gate changes; choose **Use Response** explicitly to start a new Response turn.

### Loom Phased Instructions and native context ownership

**Loom Phased Instructions** is a WORK/Agentic-only surface. Loom owns only existing prompt blocks plus these Phased Instructions; it is not a second context library. Its four fixed policy buckets route existing Loom blocks only through host-controlled checkpoints:

| Bucket | Fixed destination / checkpoint |
|--------|-------------------------------|
| **Work policy** | Root **WORK** / **WORK** |
| **Workspace usage** | Root **WORK** / **WORK** |
| **Completion criteria** | Completion handoff / **PREPARE_COMMIT** |
| **Render policy** | Tools-disabled **RENDER** / **RENDER** |

Conditions are typed, evaluate fail-closed only at the owning checkpoint against that checkpoint’s immutable snapshot, and remain fixed for that checkpoint. Bounded custom phases are current-phase-only: later phase instructions are not preloaded. Each phase may declare explicit instruction subsets for named child profiles; a child receives only its admitted subset, never the root phase instructions or another child’s subset. Response omits these agentic-only instructions while retaining the ordinary generation pipeline.

Every root WORK round receives a private structured phase-control envelope with the exact current custom phase ID, the currently admitted tool names in stable order, and the exact currently materialized open required task IDs. The phase ID is `null` when no custom phase is active.

When no custom phases are authored, WORK uses its built-in Segment. When every authored phase is optional and its frozen condition deterministically skips it, the host may likewise run exactly one built-in Segment, but only with durable authority listing those exact skipped phase IDs; recovery validates the same authority. A required phase followed only by skipped optional phases completes from the required source Segment and never creates a null successor.

The envelope directs the root to call `complete_turn` by itself after satisfying the current phase exit predicate. Before the final active custom phase, success returns `phase_advanced` and continues WORK in the next active phase; only completion of the final active custom phase—or having no active custom phase after all required completion gates are settled—can finish WORK and begin finalization. Workspace reads accept only `objective`, `constraints`, `tasks`, `records`, `submissions`, `artifacts`, and `summary`.

Phase authors must make every cross-phase dependency durable before leaving its phase: persist facts, findings, decisions, artifacts, or task results in the host-owned workspace whenever a later phase will need them. Required tasks and every unresolved required ID must be settled before phase advance. Later phases must never rely on provider prose, hidden reasoning, continuation carriers, retrieval results, or other transient context from a retired Work Segment; only accepted workspace records and the bounded handoff cross the boundary.

World Books (the native World Info system) and Databanks remain live native context systems outside Loom. World Books own lore activation, placement, attachment, editing, and access. Databanks own attached documents, attachment, editing, access, automatic semantic retrieval, and explicit `#slug` retrieval. Both use their live native objects; Loom neither copies, pins, or repairs their revisions. [Context Filters](context-filters.md) and unrelated native Loom content [packs](../packs/index.md) remain supported outside Loom.

### Choosing a mode

The chat composer shows **Generation mode** / **Next turn** when the effective-runtime check says both modes are ready for the current target. Choose **Response** or **Agentic** for one turn, or choose **Use for this chat** to save a durable chat default. A one-turn choice uses a server-issued authenticated, one-use decision token that expires after about one minute; the selected mode is held only for the current in-memory turn selection and never changes the preset. Mode precedence is:

1. the authenticated one-turn choice;
2. the durable chat override;
3. the selected preset's default;
4. **Response** as the explicit compatibility fallback.

The Agentic selector is hidden until the preset is enabled, both modes are allowed, all required slots and revisions are ready, the provider capabilities are sufficient, and the runtime health/readiness checks pass. When a repair is needed, the composer shows **Agentic mode needs attention** with a safe repair category and a **Use Response** action. A turn requested as Agentic never silently downgrades; a changed or expired preflight reports **The runtime changed before generation started. Review the mode and try again.** or **Agentic mode is not ready. Use Response or complete the listed repair.**

### Supported and unsupported surfaces

Agentic supports only these generation targets:

- normal generation;
- continue;
- regenerate; and
- swipe.

The target must be a single-character, non-multiplayer surface. Group chats, active multiplayer rooms, Council or Council-tool rounds, impersonate, quiet, raw/batch Spindle generation, and other generation surfaces are not supported by Agentic and should use Response. If a Council or group surface nevertheless shows a mode selector, choose **Response** rather than attempting Agentic. An executable agent intrinsic in Dry Run is rejected with **Agent intrinsics cannot execute during Dry Run** rather than executing provider work.

Agentic also has a deliberately closed tool boundary. It can use only the host-owned core retrieval tools selected in the preset, workspace controls, `agent_delegate` where a profile grants it, and the host-owned `complete_turn` boundary. Extension callbacks/macros/tools, MCP callbacks/tools, Council callbacks/tools, hooks, cross-domain egress grants, alternate render profiles, and future tool catalogs are Response-only and are not Agentic features.

### Configure the Agentic Runtime tab

Open the preset in Loom Builder and select **Agentic Runtime**. The tab is a shared draft; one save applies the preset block order and the normalized runtime configuration together.

1. In **Activation & Mode**, enable preset agents, allow **Response** and optionally **Agentic**, and choose the preset default. Response is always retained as the compatibility option.
2. In **Agents**, add child profiles with a stable lowercase ID, display name, a literal system prompt, a portable connection slot or **Use main connection**, allowed core tools, lore scope, delegation permission, required/optional failure policy, activity setting, output limit, and timeout.
3. In **Core Tools & Dependencies**, choose the main model's core retrieval grants and lore scope, and set `Maximum child-agent invocations` and `Maximum tool calls`. Both default to `64`, require a whole number of at least `1`, and remain subject to read-only host ceilings.
4. Use **Create prompt block with this agent** to add a directly authored `user` block in prompt order. A child block runs once in the order of the enabled blocks; a named result may be consumed only after its producer.
5. In **Phased Instructions** (the WORK/Agentic-only policy surface), select existing Loom blocks for **Work policy**, **Workspace usage**, **Completion criteria**, and **Render policy**; define bounded ordered custom phases with instruction references, explicit per-child instruction subsets, requiredness, enter/exit/skip conditions, repeat limits, adjacent transitions, and capability requests. Only the current phase’s instructions are materialized. The phase list is evaluated in authored order from **ASSEMBLE** through its declared transitions. References keep the expected preset and block revisions; changing a referenced block requires selecting the current revision. Agentic does not create a second free-form prompt or context system.
6. In **Dynamic Tasks**, define bounded task templates, dependencies, requiredness, and activation predicates. The frozen graph is evaluated on workspace creation (the ASSEMBLE activation), at each later entered runtime phase (**WORK**, **RENDER**, **PREPARE_COMMIT**, **COMMITTING**, or **COMMITTED**), after each named task or submission transition, and in the bounded completion fixed point. The completion fixed point is an internal evaluation, not a separate public phase entry. Dependency closures are activated in stable order; newly activated required tasks can block completion. Authored task templates and their dependencies may be required. Tasks created by the root during WORK are always optional; child frames cannot create tasks.
7. In **Workspace Retention & Sharing**, choose the view-only workspace retention and sharing policy. **Portability & Repair** lists unresolved or stale slots, imported review items, invalid cognition or task references, stale Loom block revisions, and provider capability mismatches. The current runtime behavior for workspace retention and visibility is described below.
8. Acknowledge every imported review item, repair the listed issues, and save. A dirty draft or a revision conflict must be resolved before changing, importing, or exporting the preset.

If **Configure Prompt Variables** reports that the preset changed elsewhere,
your unsaved values have not replaced the newer preset. Choose **Reload latest
for review** to stage the canonical values, review them, and then make any
intended changes again.

Saving **Configure Prompt Variables** without an active preset profile binding updates the preset only when the values really changed. A real change advances its revision; a structurally identical save is a no-op. Every exact reference to the previous revision—including all four policy groups, phase instructions, and per-child instruction subsets—is then listed under **Portability & Repair** until reviewed against the current revision. A bound preset profile stores its variable overlay in that profile instead and does not advance the shared preset revision.

Successful preset and profile saves invalidate the composer’s cached Agentic decision everywhere, including InputArea and LoomBuilder. Mounted readiness views refetch, stale responses cannot restore the old decision, and a Send started afterward cannot reuse an old one-use token. If revision repair is still required, preflight stops before an outbox item, runtime attempt, or provider request is created. The shared **Agent Runtime** editor is the safe atomic path for changing blocks and exact references together; ordinary preset edits quarantine stale references instead.
A config-only repair keeps the current preset revision. The shared editor submits the Loom revisions it loaded. When the same save changes prompt order, the server updates a reference automatically only if the same block occurrence stayed at the same position with the same ID, block revision, and content. Moving, adding, replacing, or occurrence-locally changing a duplicate block preserves the authored old reference and lists it for explicit revision repair instead of silently moving its authority.
Revision repair rows are not import acknowledgements: choose the current Loom revisions and save them. Only actual imported review items require acknowledgement.

Profile IDs and named results use lowercase letters, digits, and underscores, starting with a letter. `as=`, `tools=`, and `stream` are optional intrinsic options; a `tools=` list can narrow a profile's grants but cannot widen them. A profile's literal system prompt is not a place for preset macro expansion. Child timeout is edited in whole seconds with a minimum of 5 seconds. Cancelling the root turn stops active child work.

### Provider and connection requirements

The root and every deterministic or delegated child use a frozen concrete connection for the turn. A child may inherit the root connection or use a mapped portable slot. A slot declares the capabilities it requires; Agentic readiness requires generation, streaming, tool calling, tools-disabled finalization, and provider-native tool continuation for the root and every child that can dispatch. A legacy synthesized continuation remains usable only in Response/Council and does not make Agentic ready. Root and child connections must belong to the same provider trust domain. Cross-provider or cross-domain child mappings are not accepted for Agentic, even though compatible cross-provider profiles can remain usable in Response mode.

Agentic renders the final answer with the same frozen root connection and model that admitted the turn, with tools disabled. There is no alternate render profile, provider roulette, silent provider fallback, or cross-domain egress. If a slot is unresolved or stale, a provider lacks a required capability, or the provider domain differs, map a compatible local connection in **Portability & Repair** or select Response.

### Runtime budgets and safety

The authored `maxInvocations` limit controls child-agent admissions and `maxToolCalls` controls aggregate tool-call attempts for one generation. The host separately caps provider requests, retries, child output, wall-clock time, concurrent roots, tool operations, context/workspace data, and public activity storage. **Agent Runtime** in Settings and the Agentic Runtime editor show effective host ceilings as read-only information; presets, imports, and extensions cannot raise them. A portable preset remains editable when its authored value exceeds a host ceiling, but Agentic readiness rejects the turn until the value is lowered; Response remains available.

The ordinary Response Agents & Tools loop remains bounded: provider responses are validated, a complete tool batch runs in provider order, and each call receives one correlated result. Required child failures stop that Response generation; optional failures bind an empty result so later references stay deterministic. Child output is untrusted derived data and cannot supply a role, delimiter, or instruction authority over the preset, system, or user.

### Deterministic cognition and Loom policy

Deterministic cognition is authored policy rather than a hidden second prompt. A predicate can inspect only the generation type, current phase, typed preset variables, immutable participant facts, snapshotted tool availability, or a named task transition. It cannot run macros, regular expressions, JavaScript, time, randomness, database queries, or callbacks.

The frozen graph is validated before Agentic work and evaluated on workspace creation (the ASSEMBLE activation), at each later entered runtime phase (**WORK**, **RENDER**, **PREPARE_COMMIT**, **COMMITTING**, or **COMMITTED**), after each named task or child-submission transition, and in the bounded completion fixed point. The completion fixed point is an internal evaluation, not a separate public phase entry. Activation is append-only and includes dependency closures in stable order. Newly activated required tasks block completion until they are satisfied. Tasks created by the root during WORK are always optional; child frames cannot create tasks. Invalid predicates, cycles, missing templates, or changed Loom revisions fail closed rather than silently changing policy.

The four authored policy groups are:

- **Work policy** — references intended for private Agentic work;
- **Workspace usage** — authored guidance for bounded tasks, records, submissions, and artifacts;
- **Completion criteria** — authored completion requirements; and
- **Render policy** — references intended for the final tools-disabled render.

Each bucket references existing Loom blocks by exact preset and block revision. An optional typed declarative condition gates a block only at its fixed host checkpoint, using that checkpoint's immutable snapshot. The result remains sticky until the next relevant checkpoint or an explicit revision. Required invalid, stale, or unavailable inputs fail closed; optional false or unavailable inputs are visibly skipped with provenance.

World Books and Databank content never enters this revision-pinning contract. Their native attachment, access, editing, activation, placement, automatic retrieval, and explicit `#slug` behavior remains authoritative and follows live updates. Loom has no external-context storage, picker, tool, delivery policy, or repair path for these native sources.

Private WORK retrieval does not automatically cross into tools-disabled **RENDER**. Only bounded host-accepted findings, accepted task submissions, and explicitly response-shaping completion guidance in the completion handoff may cross that boundary.

### Public activity, workspace, and artifacts

After an Agentic response or swipe, the message can show an **Agentic run** strip. Open it for **Agent activity**, with an **Activity Tree** and a sibling **Workspace** tab. The tree can show safe phase chronology, root/provider/child/tool labels, status, elapsed duration, bounded token/tool/child counts, continuation mode, omissions, and a localized terminal reason. On reconnect it keeps the last known tree while the connection recovers; it does not infer failure from silence.

A terminal label keeps the run's actual cause (for example provider failure,
Stop, timeout, or exhausted budget). Reconnect recovery repairs the run's
status surfaces together; it does not replace that cause with a generic
projection error or show a terminal chat head before the durable run settles.
If a temporary persistence fault leaves the activity visibly active after work
has already ended, **Stop** performs an owner- and chat-scoped durable repair;
it does not rerun the model or replace the original terminal cause. Because the
work already ended, the repaired result may correctly appear as **Generation
failed** rather than **Generation stopped**. Only a Stop that cancels work while
it is still reversible appears as stopped.

The public projection is status-only. It never exposes prompts, work prose, child results, tool arguments or retrieval data, provider messages, credentials, raw reasoning, or continuation carriers. Separate owner-only inspection may retain a bounded WORK transcript, provider content, private child material, and tool arguments/results. Retention is subject to host limits and explicit omission markers; raw private reasoning and opaque continuation carriers are not promised. None of this becomes public activity or canonical response content.
For a Response turn, unified owner inspection remains the evidence surface for this boundary. It explains routes and order, conditions, exact source identities and preset/block revisions, hashes when recorded, one effective copy for each destination-level overlap plus every retained role/reason/overlap outcome, omissions, custom-phase and child-subset receipts, accepted crossings, and tools/delegation. If evidence is unavailable, inspection says so; it is never inferred.

The Workspace tab is separate from activity and is **view-only**. It may show bounded redacted sections for the objective (counts only), tasks, findings/decisions/questions, submissions, and artifact metadata. Task entries use generated labels such as `Task <id prefix>`; artifact entries can cover attached, proposed, or published artifacts and use generated labels such as `Artifact <id prefix>`, with MIME type, byte count, digest prefix, publication state, retention marker, and owner visibility. Authored task or artifact names/titles and private child content are not exposed; the UI does not turn the workspace into an editable document. No per-child destructive controls exist.

Workspace retention follows the selected policy within host ceilings:

- Turn-terminal workspace rows and their non-chat-lifetime child data are removed by bounded reconciliation after expiry; expired terminal projections are also cleaned up.
- Chat-lifetime workspace child rows may be preserved when this cleanup runs, and chat-owned artifact metadata can use chat-lifetime retention. Public Agent Run and Workspace reads still require a nonexpired execution; physical retention does not promise indefinite UI availability.
- The runtime carries the sharing setting, but public workspace sections currently expose owner visibility. No participant or public sharing is promised by this UI; the Workspace tab remains view-only.

For an Agentic run, the **Agent activity** inspector's Stop action is the exact root-run CAS action and returns an accepted, terminal, or too-late result. The composer may also show a Stop control for the current generation, but a generic chat-level Stop is not the same guarantee on every generation path; if it fails, use the Activity inspector and retry. The first click becomes **Stopping…** and duplicate clicks are disabled. **Too late to stop** means the run has left reversible **ASSEMBLE**/**WORK** (for example, it is completing or rendering); it cannot undo a committed response. No per-child destructive controls exist.

### Core catalog and privacy scopes

The host-owned core catalog contains:

| Tool | Purpose |
|---|---|
| `lore_list_books` | List available lore books |
| `lore_get_book` | Read one bounded lore book |
| `lore_list_entries` | List entries in a selected lore book |
| `lore_get_entry` | Read one entry by identifier |
| `lore_search_entries` | Search bounded lore results |
| `chat_search_history` | Search the immutable current-chat message snapshot |

`active` lore is the immutable enabled corpus selected for the generation, including finalized overlays and provenance. `all_owned` is a separate, explicitly granted, bounded lookup over the signed-in user's enabled lore; disabled entries are excluded. Chat search does not expose hidden messages, inactive swipes, staged targets, attachments, extras, internal rows, or another chat. No core tool exposes credentials, arbitrary database metadata, or unrestricted cross-chat search.

### Imports, quarantine, and repair

Preset files and LumiHub presets preserve authored Agentic settings but import them **disabled** and **review required**. This is a safety quarantine, not an execution consent. Before using Agentic locally:

1. open **Agentic Runtime → Portability & Repair**;
2. map every required connection slot to an authenticated local connection, or choose **Use main connection** where appropriate;
3. inspect and acknowledge each imported review item;
4. choose current Loom block revisions and repair missing or invalid cognition/task references; and
5. save the complete draft, then resolve the effective runtime again.

Foreign imports never copy credentials, local connection bindings, one-turn choices, or local activation consent. Their authored tool grants remain inert until review. Same-account duplication preserves the currently authorized preset slot bindings, normalized configuration, regex companions, and authored cognition/task envelope. Duplication still does not make a one-turn Agentic choice durable.

For the complete macro syntax and ordinary block placement, see [Macros](../customization/macros.md), [Prompt Blocks](prompt-blocks.md), and [Execution Order](execution-order.md). If a mode or repair message persists, follow [Agentic troubleshooting](../reference/troubleshooting.md).

---

## Response fallback

When Agentic is unavailable, unsupported for the surface, or not selected, choose **Response** explicitly in **Next turn** or **Use Response** in the repair banner. Response remains available even when an Agentic slot, provider, isolate, cognition, or readiness check needs repair; Agentic never silently turns a failed request into a Response turn. Selecting Response omits only WORK/Agentic-only Loom Phased Instructions. Ordinary native World Info and Databank behavior remains available through the established Response pipeline.

If no preset is linked to your connection, or the preset has no blocks, the Response path uses legacy assembly: it maps visible chat history into messages and may include character/persona context, legacy dialogue examples, and memory handling. Preset block features such as ordered world info and Author's Note are not applied.

---

## Linking Presets to Connections

Each connection can optionally link to a preset. When you generate using that connection, its linked preset is used for assembly. You can also switch presets independently of connections.
