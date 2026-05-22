# Memories

!!! warning "Permission required: `memories`"

Full CRUD access to Lumiverse's hybrid memory architecture, exposed under a single namespace:

- **Memory Cortex** — entity graph (characters, locations, items, factions, concepts, events), typed relations, narrative arc consolidations, salience records, vault snapshots, and live chat-to-chat interlinks. Includes the retrieval pipeline that fuses semantic search with salience, recency, reinforcement, emotional and entity context into a ranked `CortexResultDTO`.
- **Long-Term Chat Memory** — the vectorized chat-chunk store that powers the `{{memories}}` macro during prompt assembly: list chunks, run top-K hybrid retrieval, warm a chat (rebuild + queue vectorization), invalidate the cached retrieval.

Use this permission for extensions that visualise, edit, or augment what Lumiverse remembers about a chat — entity dashboards, relation editors, vault management UIs, alternate retrieval strategies, custom consolidation drivers, memory-aware sidebars, etc.

## Usage

### Cortex retrieval

```ts
// Top-K fused memories for a chat — the same shape the host uses internally
// during prompt assembly.
const result = await spindle.memories.cortex.query({
  chatId: 'chat-id',
  queryText: 'recent conflict with Selene',
  topK: 8,
  emotionalContext: ['betrayal', 'fury'],
  includeConsolidations: true,
  includeRelationships: true,
})

for (const memory of result.memories) {
  spindle.log.info(`${memory.finalScore.toFixed(2)}  ${memory.content}`)
}
spindle.log.info(`Entities in context: ${result.entityContext.map(e => e.name).join(', ')}`)
spindle.log.info(`Active arc: ${result.arcContext ?? 'none'}`)

// Read whatever the most recent generation saw — zero roundtrip.
const cached = await spindle.memories.cortex.getCached('chat-id')

// Linked cortex: every vault attached to the chat + every bidirectional
// interlink target, all queried in parallel.
const linked = await spindle.memories.cortex.queryLinked('chat-id', {
  queryText: 'who else knows about the dagger?',
})
```

### Entity graph

```ts
const entities = await spindle.memories.entities.list('chat-id')        // active only
const all     = await spindle.memories.entities.list('chat-id', { activeOnly: false })
const selene  = await spindle.memories.entities.findByName('chat-id', 'Selene')

// Upsert is a smart merge — matches against canonical name + known aliases.
const upserted = await spindle.memories.entities.upsert('chat-id', {
  name: 'Selene',
  type: 'character',
  aliases: ['the Lady of Ashes'],
  confidence: 0.95,
})

await spindle.memories.entities.addFacts(upserted.id, [
  "Carries a dagger inscribed with her mother's name",
  'Allergic to silver',
])
await spindle.memories.entities.updateStatus(upserted.id, { status: 'deceased' })
await spindle.memories.entities.updateEmotionalValence(upserted.id, {
  betrayal: 0.6,
  grief: 0.4,
})
```

### Relations

```ts
// Use entity names (not IDs); the host resolves canonical IDs server-side.
await spindle.memories.relations.upsert('chat-id', {
  source: 'Selene',
  target: 'Marcus',
  type: 'rival',
  label: 'duel pending',
  sentiment: -0.4,
})

const activeEdges = await spindle.memories.relations.list('chat-id')
const everyEdge   = await spindle.memories.relations.listAll('chat-id') // includes superseded
const seleneEdges = await spindle.memories.relations.forEntity('chat-id', selene!.id)
```

### Consolidations & salience

```ts
const arcs    = await spindle.memories.consolidations.list('chat-id')
const tier2   = await spindle.memories.consolidations.list('chat-id', { tier: 2 })
const current = await spindle.memories.consolidations.latestArc('chat-id')

// Fire-and-forget; new arcs become visible via list() once the background
// pass completes. Runs in extractive / heuristic mode only.
await spindle.memories.consolidations.run('chat-id')

const salience = await spindle.memories.salience.list('chat-id', { limit: 50 })
```

### Vaults & links

```ts
// Snapshot a chat's cortex state for later reuse. Copies entities + relations
// synchronously and starts a background LanceDB chunk copy.
const vault = await spindle.memories.vaults.create({
  chatId: 'chat-id',
  name: 'Campaign — Act 1',
  description: 'Frozen state at the end of the first arc',
})

const { vault: meta, entities: vaultEntities, relations: vaultRelations } =
  (await spindle.memories.vaults.get(vault.id))!

// Attach the vault as read-only knowledge to another chat.
await spindle.memories.links.attach({
  chatId: 'another-chat-id',
  linkType: 'vault',
  vaultId: vault.id,
})

// Interlink two chats so each sees the other's live entities/relations.
await spindle.memories.links.attach({
  chatId: 'chat-a',
  linkType: 'interlink',
  targetChatId: 'chat-b',
  bidirectional: true,
})

// Re-run the LanceDB chunk copy after an embedding model swap.
await spindle.memories.vaults.reindex(vault.id)
```

### Long-term chat memory

```ts
// Inspect the raw chunk index used by the {{memories}} macro.
const chunks = await spindle.memories.chatMemory.listChunks('chat-id')

// Top-K hybrid (vector + BM25) retrieval — same call as
// `spindle.chats.getMemories()` but under the memories permission.
const memoryPayload = await spindle.memories.chatMemory.get('chat-id', { topK: 6 })

// Rebuild chunks if stale and queue any pending vectorizations.
const warm = await spindle.memories.chatMemory.warm('chat-id', { force: false })
spindle.log.info(`Warmup: ${warm.status} (${warm.reason ?? 'n/a'})`)

await spindle.memories.chatMemory.invalidate('chat-id')
```

### Telemetry

```ts
const stats     = await spindle.memories.stats.usage('chat-id')
const phase     = await spindle.memories.stats.ingestionStatus('chat-id')
const timings   = await spindle.memories.stats.ingestionTelemetry('chat-id')

spindle.log.info(`${stats.entityCount} entities, ${stats.relationCount} relations`)
if (phase?.status === 'processing') {
  spindle.log.info(`Phase: ${phase.phase} (${phase.pendingJobs} job(s) queued)`)
}
spindle.log.info(`Avg ingestion: ${timings.averages.totalMs.toFixed(1)}ms over ${timings.samples} samples`)
```

## Surface

### `memories.cortex` — config, retrieval, cache

| Method | Mutates | Description |
| --- | --- | --- |
| `getConfig(userId?)` | — | Get the user's Memory Cortex configuration |
| `putConfig(patch, userId?)` | ✓ | Patch the user's Memory Cortex configuration (deep merge) |
| `query(CortexQueryDTO)` | — | Fused-score retrieval (semantic + salience + recency + reinforcement + emotional + entity) |
| `queryLinked(chatId, { queryText?, userId? })` | — | Resolve every attached vault + interlink target in parallel |
| `getCached(chatId)` | — | Read the warm cache without re-running retrieval. Returns `null` if no cached result |
| `getCachedLinked(chatId)` | — | Same as `getCached` for linked-cortex data |
| `invalidateCache(chatId)` | ✓ | Drop the warm cortex cache for a chat |
| `invalidateLinkedCache(chatId)` | ✓ | Drop the warm linked-cortex cache for a chat |

### `memories.entities` — entity graph CRUD

| Method | Mutates | Description |
| --- | --- | --- |
| `list(chatId, { activeOnly?, limit?, userId? })` | — | Defaults to `activeOnly: true`, ordered by salience |
| `get(entityId, userId?)` | — | Returns `null` if not found or not owned |
| `findByName(chatId, name, userId?)` | — | Matches canonical name + known aliases |
| `upsert(chatId, MemoryEntityUpsertDTO, { chunkId?, createdAt?, userId? })` | ✓ | Smart merge against canonical name + aliases |
| `updateStatus(entityId, { status, statusChangedAt? }, userId?)` | ✓ | Status: `active` / `inactive` / `deceased` / `destroyed` / `unknown` |
| `addFacts(entityId, facts, userId?)` | ✓ | Deduplicated; keeps the most recent 20 |
| `getFacts(entityId, userId?)` | — | Tagged branch facts are stripped for display |
| `updateEmotionalValence(entityId, valence, userId?)` | ✓ | Replaces the running emotional valence map |

### `memories.relations` — relation graph

| Method | Mutates | Description |
| --- | --- | --- |
| `list(chatId, userId?)` | — | Active edges only (excludes superseded / merged) |
| `listAll(chatId, userId?)` | — | Every edge including diagnostics rows |
| `forEntity(chatId, entityId, userId?)` | — | Active edges incident to one entity |
| `forEntities(chatId, entityIds, { limit?, userId? })` | — | Active edges across a set of entities |
| `upsert(chatId, MemoryRelationUpsertDTO, { chunkId?, userId? })` | ✓ | Both endpoints must already exist in the graph |

### `memories.consolidations` — narrative arcs

| Method | Mutates | Description |
| --- | --- | --- |
| `list(chatId, { tier?, userId? })` | — | Tier filter optional; ordered most-recent first |
| `latestArc(chatId, userId?)` | — | Most recent arc across all tiers |
| `run(chatId, userId?)` | ✓ | Background extractive consolidation (no sidecar LLM call) |

### `memories.salience` — per-chunk salience

| Method | Mutates | Description |
| --- | --- | --- |
| `list(chatId, { limit?, offset?, userId? })` | — | Ordered by `scoredAt` desc; max 500 per page |

### `memories.vaults` — frozen cortex snapshots

| Method | Mutates | Description |
| --- | --- | --- |
| `list(userId?)` | — | All vaults owned by the resolved user |
| `get(vaultId, userId?)` | — | Vault metadata + entities + relations |
| `getChunks(vaultId, userId?)` | — | The chunk snapshot copied at creation time |
| `create(VaultCreateDTO, userId?)` | ✓ | Snapshots a chat; LanceDB chunks copy asynchronously |
| `rename(vaultId, name, userId?)` | ✓ | — |
| `delete(vaultId, userId?)` | ✓ | Removes vault + chunks + attached links |
| `reindex(vaultId, userId?)` | ✓ | Re-runs the LanceDB chunk copy from the source chat |

### `memories.links` — vault attaches + chat interlinks

| Method | Mutates | Description |
| --- | --- | --- |
| `list(chatId, userId?)` | — | All links attached to a chat |
| `attach(ChatLinkAttachDTO, userId?)` | ✓ | Vault attach or interlink (pass `bidirectional: true` for the reverse edge) |
| `remove(chatId, linkId, userId?)` | ✓ | — |
| `toggle(chatId, linkId, enabled, userId?)` | ✓ | Enable / disable without removing |

### `memories.chatMemory` — long-term chat memory (the `{{memories}}` macro)

| Method | Mutates | Description |
| --- | --- | --- |
| `listChunks(chatId, userId?)` | — | All vectorized chunks for a chat, oldest first |
| `get(chatId, { topK?, userId? })` | — | Top-K hybrid vector + BM25 retrieval (`ChatMemoryResultDTO`) |
| `warm(chatId, { force?, userId? })` | ✓ | Rebuild stale chunks and queue pending vectorizations |
| `invalidate(chatId, userId?)` | ✓ | Drop the cached `{{memories}}` retrieval result |

### `memories.stats` — telemetry

| Method | Mutates | Description |
| --- | --- | --- |
| `usage(chatId, userId?)` | — | Entity / relation / consolidation / salience counts |
| `ingestionStatus(chatId, userId?)` | — | Live phase + pending job count; `null` when never ingested |
| `ingestionTelemetry(chatId, userId?)` | — | Last sample + per-phase averages over recent ingestions |

## Ownership & scoping

Every chat-scoped call verifies chat ownership against the resolved user before reading or mutating cortex state. Entity-scoped and vault-scoped calls do the same via the owning chat / vault row. Extensions cannot read or mutate memories for chats they do not own — calls referencing other users' chats return `null` (for reads) or throw `Chat not found` / `Vault not found` / `Entity not owned by caller` (for writes).

For user-scoped extensions, `userId` is inferred from the extension owner. For operator-scoped extensions, pass `userId` explicitly on each call.

## Permission denials

Calls without the `memories` permission throw a structured error prefixed with `PERMISSION_DENIED:`:

```ts
try {
  await spindle.memories.entities.list('chat-id')
} catch (err) {
  if (err.message.startsWith('PERMISSION_DENIED:')) {
    spindle.toast.warning('Enable the "Memories" permission to use this feature.')
  } else {
    throw err
  }
}
```

See [Permissions](../getting-started/permissions.md#handling-permission-denials) for the broader pattern.

## Notes

- **`consolidations.run()`** runs in extractive / heuristic mode only (no sidecar LLM call). Sidecar-driven consolidation is owned by the host and is triggered automatically during ingestion; it is not exposed to extensions because it needs route-layer connection plumbing that doesn't belong in the worker host.
- **`relations.upsert`** silently drops edges whose endpoints aren't in the graph yet — call `entities.upsert` for both endpoints first. The method returns the newly-created or reinforced row, or `null` if it was dropped.
- **Caches** are keyed per chat with a 5-minute TTL. `getCached` / `getCachedLinked` return `null` when no result is available; they never trigger a re-query.
- **Vault `create`** writes the entity + relation snapshot synchronously and copies LanceDB chunks in the background. Use `reindex` to re-run the chunk copy after an embedding model swap or LanceDB reset. The vault remains queryable in structural-only mode until the chunk copy finishes.
- **`chatMemory.warm`** is a no-op when chat vectorization is disabled (returns `{ status: 'skipped', reason: 'chat_vectorization_disabled' }`). Check the user's embedding configuration first.
- The host does **not** expose `processChunk`, `runMaintenance`, or `debouncedVectorize`. Those are pipeline-internal and would let an extension inject synthetic chunks; cortex ingestion stays the host's responsibility.

## See also

- [Chats — `getMemories()`](chats.md#chat-memories) — the lightweight retrieval-only alias under the `chats` permission, equivalent to `memories.chatMemory.get()`.
- [Permissions](../getting-started/permissions.md) — how permission grants and revocations are handled at runtime.
