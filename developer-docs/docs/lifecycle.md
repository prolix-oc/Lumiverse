# Lifecycle

## Installation

1. User provides a GitHub URL
2. Lumiverse clones the repo to `{DATA_DIR}/extensions/{identifier}/repo/`
3. Reads and validates `spindle.json`
4. If no `dist/` folder exists, runs `bun build` on `src/backend.ts` and `src/frontend.ts`
5. Extension is registered in the database
6. Backend runtime is started if the extension is enabled

## Enable / Disable

- **Enable:** starts the backend runtime and schedules the frontend module to load
- **Disable:** sends `shutdown` to the backend runtime (5s grace period), tears down the frontend module, unregisters all macros/interceptors/tools/context handlers, and stops any active frontend processes owned by the extension

By default, backend runtimes start in `process` mode. See [Runtime Modes](getting-started/runtime.md) for platform-specific behavior.

## Update

1. Runs `git pull` in the extension's repo directory
2. Re-reads `spindle.json`
3. Rebuilds from source if needed
4. Restarts the backend runtime if the extension was running

## Removal

1. Stops the backend runtime
2. Deletes the database row (cascades permission grants)
3. Deletes the extension directory (repo + storage)

## Startup Order

On Lumiverse boot, all enabled extensions are started after database migrations complete. Extensions should not depend on a specific load order.
---

## WORK Engine lifecycle

The WORK Engine is a strict, single-turn runtime behind the authenticated
generation routes. A request creates one **Turn Execution** and one immutable
attempt lineage. An attempt contains ordered durable **Work Segments**, never a
new user turn per segment. The request is admitted only after the server resolves
the authenticated target, runtime mode, concrete provider capability set, frozen
input revisions, and readiness gates. A request that asks for WORK never
silently becomes Response.

### Phase, status, and outcome vocabulary

The public Agent Run lifecycle is:

`ADMIT` → `ASSEMBLE` → `WORK` → `PREPARE_COMMIT` → `RENDER` → `COMMIT` →
`TERMINAL`.

`PREPARE_COMMIT` is the public completion/freeze handoff. At that boundary,
the host has accepted completion and frozen the workspace and render context
that final rendering will consume. These public phases are projections; do not
derive their order from the runtime's similarly named internal states.

The status is one of `pending`, `running`, `waiting`, `cancelling`, or
`terminal`. A terminal Turn Session has one outcome: `completed`, `stopped`,
`failed`, `exhausted`, or `rejected`. `workPhase`, `workStatus`, and
`workOutcome` are independent fields; a client must not infer one from another
or from stream silence.
For every nonterminal execution phase, `workOutcome` is `null`; the status
remains phase-specific (`pending`, `running`, `waiting`, or `cancelling`).
`COMMITTED` is the only successful terminal boundary and projects to
`completed`. `CANCELLED` projects to `stopped`, `TIMED_OUT` (including
`root_wall_clock_limit_exceeded`) projects to `failed`, and `EXHAUSTED`
projects to `exhausted` only for a host-enforced budget or limit exhaustion.


Every public run carries `attemptLineage`:

```ts
{
  version: 1,
  attemptId: string,
  previousAttemptId: string | null,
  target: {
    chatId: string,
    generationType: 'normal' | 'continue' | 'regenerate' | 'swipe',
    messageId: string | null,
    swipeId: number | null,
  },
  createdAt: number,
}
```

The `attemptId` identifies this attempt; a retry creates a new attempt whose
`previousAttemptId` points to the inspected terminal attempt. A refused retry
creates no attempt, projection, or terminal publication.

### Request through terminal behavior

1. **Request:** the authenticated client posts `/api/v1/generate` (or the
   canonical regenerate/continue route) with `chat_id` and an explicit
   `mode`. Omitting `mode` retains the existing Response path.
2. **Admission:** `mode: 'agentic'` consumes the one-use effective-runtime
   decision (or performs the same authenticated resolution when no token is
   supplied). Target, revision, capability, isolate, publication, context,
   and kill-switch changes fail closed.
3. **Assembly:** the host freezes the `GenerationAssemblySnapshotV1` and
   produces an `AssemblyPlanV1`. No provider request or workspace mutation is
   made before the plan passes validation.
4. **WORK:** deterministic child descriptors run in order, then the root runs
   one or more ordered Work Segments with only its admitted tool/delegation
   capabilities. Every segment receives fresh current-phase provider context;
   prior-segment provider prose/messages, tool calls/results, hidden reasoning,
   opaque continuation carrier, and stale phase instructions are not replayed
   into it. This next-segment retirement does not reduce the pre-existing
   bounded provider/tool fields available to authenticated owner inspection;
   only raw hidden reasoning and opaque continuation carriers are prohibited.
   The provider-neutral `WorkSegmentRunnerV1` owns this boundary: one future
   Pi run maps to exactly one admitted segment, while the host alone owns
   completion, final render, durable commit, and attempt closure.
5. **Completion handoff and render:** public `PREPARE_COMMIT` marks accepted
   completion and freezes the workspace and render context. Public `RENDER`
   then produces the final response with tools disabled. A tool call in
   finalization is a protocol failure, not another delegation.
6. **Commit or terminal:** public `COMMIT` includes the pure, snapshot-bound
   `prepareRender()` processing and the durable commit attempt. One
   compare-and-set owner decides whether the canonical write can begin. A
   successful durable commit writes the message/swipe and terminal receipt in
   one transaction. Cancellation, deadline, provider failure, required-work
   failure, or exhaustion before that boundary produces a terminal outcome
   without an authoritative chat write.

Within WORK, each provider result is durably classified as an admissible host
tool action, tool-free stop, reasoning-only stop, reasoning-only length
exhaustion, empty provider response, or provider protocol failure. An admitted
tool action executes and settles before continuation. Tool-free and
reasoning-only stops consume bounded unsigned-boundary recovery; length
exhaustion may roll over under the same authored occurrence. Empty or protocol
failure boundaries recover only under explicit host policy and otherwise close
with a typed cause; an unknown in-flight dispatch is never replayed. Recoverable
boundaries close only the current segment. Only terminal attempt failure,
exhaustion, or cancellation closes the attempt. Provider prose never chooses
the recovery branch.

Four limits remain independent: attempt budget, segment budget, the hard
per-dispatch output cap, and protected recovery/future-phase reserves. Exhausting
one does not borrow from or reset another. Terminal closure records a typed
`failed`, `exhausted`, or `cancelled` result and stable cause. Authored advance
may release reserve only for phases no longer required; repeat and rollover
cannot. Required-tool recovery is available only when the frozen provider
positively declares provider-neutral support and at least one host tool is
admitted.

When a durable Segment lifecycle is present, its attempt, segment, dispatch,
reserve, unsigned-boundary, tool, and workspace-operation balances are the sole
WORK budget authority; the legacy process-wide provider/tool/workspace fuses
remain only for non-segment callers. Workspace operations reserve their durable
count before the side effect, including failed operations. Provider billing
uses the conservative canonical result across visible content, reasoning,
thinking blocks, and tool payloads when provider usage is absent or lower;
visible output bytes remain a separate publication bound.

Crash persistence is ordered: reserve the dispatch, mark it in flight, settle
its boundary and accepted workspace effects, commit the handoff/segment close,
then admit the successor. Every step is idempotent under exact identity and CAS.
Recovery atomically claims one admitted no-dispatch Segment before resolving a
credential or provider. It reconstructs only the persisted input, decision,
target, snapshot, phase, workspace, tool-grant, owner-limit, and attempt
authorities, then enters the admitted-Segment resume seam without replaying
Assembly, deterministic children, Cortex, council, or pre-Segment mutations.
The execution-owner lease renews from WORK entry through Cortex, children, and
council under the immutable admitted owner token, CAS revision, and runtime
epoch. On first durable Segment admission, the host performs an immediate
segment-fenced renewal, arms that cadence, and only then joins the generic
cadence, so the ownership handoff has no unleased gap. An admitted recovered
Segment that is cancelled or fails before its first dispatch performs the same
handoff before terminal preparation; only a close with no durable Segment may
final-renew and stop the generic cadence directly. The process registry retains
ownership of the generic cadence through root credential resolution, option
construction, and resumed-input validation. A single failure-safe ownership
scope removes the registry entry and joins the timer on every return or throw,
including failures before the runner reaches its guaranteed-close boundary.
Each in-flight dispatch lease renews independently under its exact
segment/dispatch fence; losing any fence aborts the local provider signal and
leaves unknown dispatch work for later fencing. Renewal remains active through
dispatch settlement and terminal
preparation. The host then joins one final fenced renewal, stops the cadence,
and immediately performs the synchronous atomic terminal write under that
retained, unexpired authority; no renewal may run after the recovery row closes.
A lost owner fence projects typed recovery failure rather than an apparent
local close. Recovery may also atomically admit the deterministic successor in
the zero-active committed-handoff gap, but never duplicates
unknown provider work, tools-disabled render, or the atomic chat commit.

### Authoring WORK phases

Author each phase as one bounded objective with explicit exit criteria and the
smallest capability set it needs. Fresh context includes the frozen root
objective/snapshot, exact current-phase instructions and criteria, frozen
admitted tool/delegation capabilities and protocol capability state, remaining
budgets, host-accepted workspace records and open required IDs, and at most the
previous bounded handoff. It excludes prior-segment provider prose/messages,
tool calls/results, hidden reasoning, opaque continuation carrier, stale phase
instructions, and unaccepted workspace/prose claims.
Immediately before durable dispatch reservation, the Segment owner reconstructs
the provider input from those authorities, appends occurrence messages followed
by exactly one fresh host phase-control message, clones the final aggregate, and
applies the trusted input-byte bound. Reconstruction failure or an over-limit
aggregate creates no dispatch reservation and incurs no provider charge.

Facts needed later must be recorded durably through accepted workspace records,
accepted submissions, or the bounded handoff. Provider prose and tool-result
text are not continuity. **Advance** selects a declared later phase. A
**same-phase repeat** creates a new segment and increments the authored phase
occurrence. A **recovery rollover** creates a new segment but retains the same
authored occurrence. A skipped phase creates no segment. A preset with no custom
phases has exactly one WORK segment unless recovery creates a rollover segment.
The declared plan is immutable: runtime routing cannot synthesize a phase or
carry provider text across a boundary.

The immutable execution row is terminal cause authority. Terminal publication
then uses one exact-identity transaction for the persistent Turn Session,
inspection attempt, Agent Run projection, compatibility activity, and terminal
outbox. Only after that transaction commits may the Agentic pool or compatibility
websocket event become terminal. If convergence is interrupted, the original
WORK/COMMIT cause remains unchanged and startup or exact dormant Stop repairs
the durable owner surfaces idempotently without replaying provider work.
Ordinary phase publication stops before every terminal phase; only the terminal
publisher may freeze the cause-aware terminal surfaces. Startup may append one
recovered terminal revision for the known premature generic
`FAILED / failed / internal_error` projection only when the immutable
execution and exact inspection agree on `FAILED / rejected / invalid_input`,
the target identity is exact, and no commit receipt exists. Any near-match or
unrelated terminal mismatch remains immutable and fails readiness closed.
This includes failures after durable admission but before workspace setup
finishes: an authoritative `agentic_runtime_unavailable` execution converges
an absent inspection/projection pair as terminal `rejected / invalid_input`,
never as a conflicting generic failure. Cleanup releases process resources
only. When source-chat deletion
has already removed every chat-owned projection, recovery converges the
surviving detached Turn Session from the terminal execution and emits no chat
event.

Internally, after WORK completes and freezes, the orchestrator enters
`COMPLETE`, enters `RENDER` and calls `render()`, then enters its internal
`PREPARE_COMMIT` state and calls `prepareRender()` before `commit()`.
Those are implementation states and calls, not additional public phases.
Internal `COMPLETE` supplies the public `PREPARE_COMMIT` completion handoff,
and internal `RENDER` supplies public `RENDER`. Internal `PREPARE_COMMIT`,
which calls `prepareRender()`, and `COMMITTING` both project as public `COMMIT`.
They do not insert another public completion handoff after `RENDER`; the durable
commit CAS and transaction remain the only authority for the canonical write.

`POST /api/v1/agent-runs/:turnId/stop` returns `accepted` only while the run
is reversible, `too_late` after the completion boundary, or `terminal` once a
terminal owner has settled it. The compatibility
`POST /api/v1/generate/stop` returns `accepted`, `too_late`, or
`not_found` with `{ stopped, status }`; an already-terminal durable run
instead returns `{ stopped: false, status: "terminal", terminal }`, where
`terminal` is the canonical Agent Run Stop result plus `generationId`.
If live terminal publication failed and its in-memory generation registration has
already been released, generic generation Stop resolves the exact owner/chat/turn
execution, repairs its durable terminal surfaces, and only then settles the
visible pool. A mismatched owner or chat cannot invoke this recovery. The repair
returns the existing canonical `terminal`/`too_late` result, never `accepted`;
the composer consumes that terminal outcome before settling request/stream state,
so FAILED replaces any optimistic stopped state while a genuinely reversible
accepted cancellation still renders stopped.

### Inspection, recovery, and retention

The authenticated owner follows a run through the Agent Run projection and
owner inspection surfaces, not by interpreting event silence or message text.
Inspection list/detail reads re-check the authenticated owner, chat, attempt,
target, and stored Turn Session identity. A foreign, missing, expired, or
no-longer-visible record is a non-disclosing `404`.

Inspection is layered: summary/activity, Turn Session entries, transcript
records, prompt evidence, Cortex/Council receipts, workspace associations,
usage evidence, and causal error detail are separate retained projections.
Prompt evidence persists a required canonical source occurrence: frozen Loom `blockId + promptOrder + blockRevision` for cognition, assembly provenance identity/revision/`sourceIndex` otherwise. Projection and owner inspection fail closed on missing, malformed, truncated, or conflicting occurrence identity, so one same-ID/revision sibling or incomplete retained prefix cannot supply another occurrence's role or content.
Bounded omission markers identify reconnect gaps, truncation, unavailable
layers, withheld credentials, and recovered duplicates. Public run payloads
remain status-only and never contain prompts, work prose, provider carriers,
tool arguments/results, credentials, or private child content.

The inspection service bounds each payload to 64 KiB, each audit record to
128 KiB, each attempt to 4,096 records, and each list response to 64 runs.
These are retention/read bounds, not a promise that every private event is
available. The activity fallback is separately bounded to the newest 16
runs per chat and 512 KiB total.

Recovery is host-owned. `recoveryEligible` and `recoveryAction` are returned
with the run/error projection; clients must not manufacture a retry or repair
action. `POST /api/v1/agent-runs/:attemptId/retry` accepts only an empty body
or `{}` and admits only an owner-scoped terminal attempt with a still-valid
target and retryable outcome (`failed`, `exhausted`, or `stopped`). The `202`
response contains the new attempt lineage only after durable admission.

### Context ownership and prompt handoff

World Books and Databanks remain native, live context systems outside Loom. World Books own lore activation, placement, attachment, editing, and access; Databanks own document attachment, editing, access, semantic retrieval, and explicit `#slug` retrieval. [Context Filters](../../user-docs/docs/presets/context-filters.md) and unrelated native Loom content [packs](../../user-docs/docs/packs/index.md) remain supported. Loom does not copy, pin, or repair these objects.

Loom owns only existing prompt blocks plus **Phased Instructions**. Fixed buckets route work policy and workspace usage to root **WORK** / **WORK**, completion criteria to completion handoff / **PREPARE_COMMIT**, and render policy to tools-disabled **RENDER** / **RENDER**. Conditions fail closed at their owning checkpoint against its immutable snapshot and remain fixed. Custom phases are bounded and current-phase-only with explicit per-child instruction subsets. After PREPARE_COMMIT accepts the current root turn, RENDER frames the native conversation with a concrete accepted workspace envelope before the consumed user request, and keeps the host-owned handoff after authored render policy as the final policy message. The envelope records host authority, accepted status, current scope, exact frozen workspace revision, and a full-request binding to the final user-role message by host-fixed position, UTF-8 byte length, and SHA-256 digest. It requires a completed/settled response and forbids future-tense execution announcements or next-phase/tool narration because WORK is already terminal. Stale, missing, or differently labeled evidence cannot negate the terminal record or make the final response report that the current turn was never executed or lacks a handoff.
RENDER does not copy user-authored request text into a host-authority system record. The terminal record instead binds to the final user-role message already present in the frozen provider request by its zero-based host-fixed message position, complete UTF-8 byte length, and SHA-256 digest. The full request remains in its user role, so multiline or system-looking user text cannot become system policy and requests longer than 1,024 characters are bound without truncation or misleading "exact text" claims. The host record also states that the referenced request was already executed by WORK, that its imperative wording is historical input rather than pending RESPONSE work, and that tools-disabled RENDER must not deny the WORK capabilities recorded by the accepted projection.

Unified owner inspection explains route/order, roles, conditions, source identities and revisions/hashes when recorded, destination-level deduplication, omissions, custom-phase/child-subset receipts, accepted WORK-to-RENDER crossings, and tools/delegation. Unavailable evidence is marked unavailable and never inferred. Only bounded host-accepted findings, accepted task submissions, and explicitly response-shaping completion guidance cross private WORK; ordinary Response preserves the conversation and native World Book/Databank assembly while omitting private WORK. The retired **Context Pack**, **Context Library**, and **Progressive Context** surfaces are unsupported.
