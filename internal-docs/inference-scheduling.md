# Inference Scheduling

`src/services/inference-scheduler/` is a process-wide admission scheduler for
requests that share local model hardware. It exists so the Memory Cortex
sidecar, chat streaming, chunk embedding, and image generation cannot all load
the same GPU/VRAM at once.

The scheduler is **opt-in per user** (`inferenceSchedulerConfig`). When it is
disabled, every call site runs through an unscheduled lease and behavior is
unchanged.

## Model

- **Resource** — one queue. Resolved from the endpoint origin:
  excluded → named group → explicit extra origin → local endpoint (unified or
  per-origin). See `resources.ts` and `origin.ts`.
- **Local** — loopback, RFC1918, IPv6 ULA/link-local, and `.local`/`.lan`/
  `.internal` names. `schedulePrivateNetwork` only relaxes the private ranges.
- **Lease** — one admitted request. `acquireInferenceLease` /
  `withInferenceLease` / `withInferenceLeaseStream`.
- **Class** — `interactive`, `user`, `retrieval`, `background`, `bulk`
  (priority 0–4). Aging promotes waiters down to `retrieval`, never above it.
- **Preemption** — an `interactive`/`user`/`retrieval` waiter can abort an
  active `background`/`bulk` lease. The aborted holder's `lease.signal` fires;
  use `withLeaseAbort(callerSignal, lease)` when passing it to a provider.
  `withInferenceLeaseStream` propagates the abort reason even when a provider
  ends its stream normally after cancellation. Nonstreaming consumers must also
  check for cancellation before returning a result (see `throwIfGenerationAborted`).
- **Shared limits** — a resource tracks each participant's configured
  concurrency and admits against the smallest value. One account cannot raise
  another account's limit; a participant's entry drops when it has no active or
  waiting work.

Queue labels, counters, activity timestamps, and request details are scoped to
the authenticated user, including when several accounts share a pool.

Leases are re-entrant within an async call stack using `AsyncLocalStorage`: a
nested call for the same resource is unscheduled and reuses the outer slot
rather than deadlocking. Nested work inherits the outer cancellation signal;
async work that outlives a released lease must acquire a new slot.
For streams, each pull and iterator cleanup run inside
the lease context. The slot stays held until provider cleanup finishes, even
when the consumer closes the stream early; cleanup failures still release it.

Stream consumers must close the iterator in a `finally`. Abandoning a leased
iterator (for example when a stop signal throws between chunks) would otherwise
hold the admission slot forever; the chat loop and image streaming path both do
this.

## Call sites

| Path | Class | Notes |
| --- | --- | --- |
| `generate.service.ts` chat stream | `interactive` | Wraps each provider round; released while tools run |
| `generation/direct-generation.ts` quiet/raw generate | `background` / `user` | Sidecar and extension calls; `GenerationCallOptions.leaseClass` overrides |
| `generate.service.ts` summaries / rebuild batches | `user` / `background` | |
| `image-gen.service.ts` `runProviderGeneration` | `user` | Resolves the provider's default URL before admission so connections without `api_url` still queue |
| `weaver/visual/service.ts` | `user` | Visual Studio jobs |
| `embeddings.service.ts` driver | `retrieval` for query input, `bulk` otherwise | Endpoint comes from the driver's `api_url` |
| `vectorization-queue.service.ts` subprocess dispatch | `bulk` | Host leases the batch; aborting terminates the child and waits for exit |
| `cortex-warm-worker-client.ts` | `background` | Per-chat dedup happens before admission; aborting terminates the worker |

Chat's inactivity watchdog excludes admission wait and starts a fresh provider
inactivity budget when the lease is granted. Explicit Stop still cancels queued
requests.

### Worker threads and subprocesses

Queues only exist in the host process.

- Worker threads are detected with `Bun.isMainThread === false`.
- The chat-chunk vectorization subprocess is spawned with
  `LUMIVERSE_INFERENCE_SCHEDULER=child`.
- The host leases subprocess work at dispatch granularity (one embedding batch),
  which keeps interactive preemption responsive. The lease signal is passed into
  the dispatch call; aborting removes a queued batch or terminates the child and
  waits for it to exit before the lease is released.
- Cortex warm jobs deduplicate per chat **before** admission. A newer warm
  request supersedes a waiting one by aborting its admission. Preempting an
  active job terminates its worker.

Do not wrap CPU-only work (tokenization, prompt assembly) in a lease: it would
serialize unrelated work for no GPU benefit.

## Configuration and API

Stored under the `inferenceSchedulerConfig` setting key and normalized by
`config.ts` (clamped numbers, normalized/deduplicated origins, group ids).
Cached for 5 seconds, invalidated on write.

- `GET /api/v1/inference-scheduler` — config, status, discovered endpoints.
- `GET /api/v1/inference-scheduler/config` / `PUT .../config`
- `GET /api/v1/inference-scheduler/status`
- `GET /api/v1/inference-scheduler/endpoints`

`discovery.ts` reads configured chat, embedding, image, and Memory Cortex
connections without contacting them. Explicit `extraOrigins` and
`excludedOrigins` are always listed as `manual` entries so a hand-added origin
can be excluded, re-included, or removed through the UI.

Queue transitions also publish `INFERENCE_SCHEDULER_STATE` on the user's
WebSocket topic, debounced to at most one event per user every 500 ms with
`{ status, at }`. The notifier is registered from `app.ts`; keep it out of
worker/subprocess imports.

## Tests

- `scheduler.test.ts` — FIFO within class, priority ordering, preemption,
  aging, max wait, abort, re-entrancy during consumption and cleanup, stream
  release after cleanup (including errors), per-user concurrency limits,
  status isolation.
- `embeddings.service.inference-scheduling.test.ts` — optional real HTTP
  serialization and nested cancellation against the committed Postman fixture;
  see `postman/simulations/inference-scheduler/inference-scheduler.context.md`.
- `notifier.test.ts` — debounced `INFERENCE_SCHEDULER_STATE` payloads and
  per-user isolation.
- `discovery.test.ts` — manual origin listing and de-duplication.
- `generate.service.stream-lease.test.ts` — Stop releases the chat lease.
- `generate.service.stream-lease-consumer-throw.test.ts` — a consumer throw
  between chunks cannot leave the iterator (and lease) open.
- `direct-generation.inference-scheduling.test.ts` — preemption rejects partial
  results for quiet/raw calls and streams, cleanup finishes before admitting
  chat, and uninterrupted streams complete normally.
- `cortex-warm-worker-client.test.ts` — pre-admission dedup and worker
  termination on preemption.
- `config.test.ts`, `resources.test.ts`, `origin.test.ts` — normalization and
  resolution.
- `src/routes/inference-scheduler.routes.test.ts` — API contract.
- `frontend/src/components/settings/InferenceSchedulerSettings.test.tsx` — UI.

Tests use `__test__.setConfig` / `setHost` / `setClock` and
`resetInferenceSchedulerForTests()` for deterministic behavior.

## Limits

- Extension-registered sidecar providers that make their own HTTP calls are not
  scheduled.
- Resources are keyed globally, so accounts that share hardware coordinate only
  when their configs resolve to the same resource key.
- The scheduler queues work; it does not unload models. Idle unloading stays a
  provider concern.
