---
title: Milvus maintenance
---

# Milvus maintenance

Lumiverse supports Milvus 3.0 through the Node SDK. Collection migrations and
BM25 backfills are explicit maintenance operations. Run the commands below from
the backend checkout with Bun and its dependencies installed.

## Connection and write policy

The tools read `LUMIVERSE_MILVUS_ADDRESS`, `LUMIVERSE_MILVUS_DATABASE`,
`LUMIVERSE_MILVUS_USERNAME`, `LUMIVERSE_MILVUS_PASSWORD`, and
`LUMIVERSE_MILVUS_SSL`. They do not read the running application's encrypted
owner credentials; supply credentials through the process environment. Use a
trusted machine and keep checkpoint and repair files private.

All retrieval paths request Strong consistency, including filtered reads,
counts, dense search, BM25, and hybrid search. Successful collection/index setup
is cached until reset or reconnection; failed setup remains retryable.

The default **Flush after each write** behavior remains available. After live
validation, select **Flush during maintenance** in Operator's Milvus settings
and choose **Apply Runtime Tuning**. For an environment-managed connection,
`LUMIVERSE_MILVUS_FLUSH_POLICY=manual` also sets the initial policy; a policy
saved in Operator takes precedence over that environment variable.
The maintenance policy also prevents ordinary embedding orchestration from
immediately requesting another flush. Explicit maintenance still flushes. Strong reads can increase
search latency; benchmark the complete workload before adopting this policy.

## Inventory and server settings

```sh
bun run milvus:maintenance inventory
```

The report lists the active collections, schemas, dimensions, row counts,
indexes, statistics, and BM25 eligibility. Required settings are reported as
requirements, not as verified running values. A successful connection does not
prove that these features are enabled.

Text requires StorageV3:

```yaml
common:
  storage:
    useLoonFFI: true
```

Adding BM25 to existing data additionally requires:

```yaml
dataCoord:
  compaction:
    bumpSchemaVersion:
      enabled: true
    storageVersion:
      enabled: true
```

Apply and verify these values through your Milvus deployment's configuration
workflow. StorageV3 changes persisted storage formats and limits downgrade
compatibility. See [Milvus StorageV3 documentation](https://milvus.io/docs/storage-v3.md).

## Text and BM25 migration

Stop **every** Lumiverse instance and other writer using these collections for
the maintenance window. Keep them stopped through validation and cutover. The
tool detects source changes but cannot enforce a write lock across applications.
Use a separate checkpoint for each logical collection; repeat the sequence for
`embeddings_world_books` and `embeddings` as needed.

```sh
bun run milvus:maintenance plan-text --collection embeddings_world_books --checkpoint data/milvus-world-books.json
bun run milvus:maintenance run --checkpoint data/milvus-world-books.json --writers-stopped
bun run milvus:maintenance cutover --checkpoint data/milvus-world-books.json --writers-stopped
```

Planning creates a checkpoint without altering collection schemas. Running
creates a uniquely named replacement with Text content, BM25, and its dense,
sparse, and scalar indexes. The copy uses bounded primary-key pages, so it can
scan beyond Milvus's offset result window. It reuses unchanged numeric vectors;
it does not change embedding models or dimensions.

Progress is saved after each acknowledged upsert batch. On interruption, rerun
`run` with the same checkpoint and repair input. Replaying an uncertain batch is
idempotent. If the process was killed, verify it is no longer running before
removing its stale `<checkpoint>.lock` file. A source change requires a new plan;
the previous collections remain available for inspection.

Before marking the replacement ready, the tool seals it, waits for indexes, and
compares a full fingerprint of IDs, tenant/source ownership, content, metadata,
timestamps, and float32 vectors. Cutover repeats the comparison and updates
`lumiverse_active_embeddings_world_books` or `lumiverse_active_embeddings`.
Restart Lumiverse afterward: routing and schema caches resolve per connection.

A vector-store reset clears the active Text collection while retaining its
schema and routing alias. If the next embedding model has a different dimension,
an empty replacement is created before routing switches to it. Nonempty
collections continue to reject dimension mismatches. Retained rollback copies
remain separate operator cleanup items.

### Previously clipped content

The tool blocks migration if a row ends with the legacy `[content clipped]`
marker. It cannot recover missing text from Milvus. Rebuild affected rows from
canonical SQLite/source records with the **same embedding model, dimensions,
revision, and embedding-input rules**, then supply a JSONL repair file:

```json
{"sourceHash":"SHA256_OF_OLD_ROW","row":{"id":"...","user_id":"...","source_type":"...","source_id":"...","owner_id":"...","chunk_index":0,"content":"full canonical content","metadata_json":"{}","updated_at":123,"vector":[0.1,0.2]}}
```

Compute `sourceHash` with the exported `milvusRowHash(oldRow)` helper in
`src/services/vector-store/providers/milvus-maintenance.ts`. Each record contains
a complete rebuilt VectorRow. Only content/vector changes are allowed; a changed
revision, identity, ownership, or metadata requires normal source reindexing.
The tool verifies the old-row hash and vector dimensions; the repair producer
must establish canonical-source and embedding-model provenance. This command
does not generate embeddings or independently verify that provenance.

Pass `--canonical-rows FILE` to **every** command for that checkpoint, including
planning and rollback. The repair file's digest is bound into the checkpoint.
Oversized metadata remains subject to its VARCHAR limit and must be repaired
through normal source reindexing.

### Rollback

Keep writers stopped, then run:

```sh
bun run milvus:maintenance rollback --checkpoint data/milvus-world-books.json --writers-stopped
```

Restart Lumiverse after rollback. The command refuses to switch back if either
collection has changed since validation; reconcile new writes first. It retains
both physical collections. Deleting obsolete collections is a separate operator
operation after the rollback period.

## In-place BM25 backfill

A healthy collection with BM25 already defined needs no function backfill.
In-place backfill accepts an existing analyzer-enabled VARCHAR content field.
The legacy dense-only fallback lacks that analyzer and requires replacement.
Text collections must have BM25 defined when created. See
[Milvus schema-change limits](https://milvus.io/docs/add-fields-to-an-existing-collection.md).

```sh
bun run milvus:maintenance plan-bm25 --collection embeddings --checkpoint data/milvus-bm25.json
bun run milvus:maintenance run --checkpoint data/milvus-bm25.json --writers-stopped
```

The operation adds the sparse output, function, and bound index together, then
waits for valid segment counters and Finished indexes with no pending rows.
Missing counters, partial coverage, and an accepted schema change do not count
as completion. Nonempty collections require positive segment totals. Index
failures stop immediately; timeouts retain the checkpoint for resume. The
default polling timeout is ten minutes, adjustable with `--timeout-ms`.
Restart Lumiverse after completion to clear schema and search-fallback caches.
This operation retains the original collection and does not automatically drop
the newly added function on failure.

## Benchmarking and live validation

```sh
bun run bench:milvus --rows 10000 --queries 50 --flush-policy manual
bun run bench:milvus --rows 10000 --queries 50 --flush-policy per_write
bun run bench:milvus --rows 10000 --queries 50 --index-type HNSW --index-params '{"M":32,"efConstruction":200}' --search-params '{"ef":128}'
```

The benchmark copies a bounded corpus into a temporary collection, uses separate
writer/reader clients, and removes its own collection afterward. It verifies
immediate insert/update/delete visibility for filtered reads, counts, dense,
lexical, and hybrid search, plus tenant isolation, without flushing between the
probe's writes and reads. A failed check aborts the benchmark.

Reports include ingestion throughput, index build time, filtered dense recall
against exact cosine results, and dense/BM25/hybrid p50/p95 latency. Lexical and
hybrid latency are measured where query terms exist; they are not semantic
quality scores. Compare only matching corpus hashes and comparable server load.
The bounded corpus uses primary-key order; select a representative collection
and adequate corpus size. Record server RSS/index memory externally during each
run. `--text` exercises the Text schema and requires StorageV3.

Small sealed segments may remain below Milvus's index-building threshold. Check
`denseIndexedRows` and `indexCoverageAdequate` before drawing conclusions about
index algorithms; otherwise the run can largely measure brute-force search.
Frequent flushes can produce this situation.

New Milvus 3.0 algorithms require opting into target vector index version `10`
and scalar index version `4` in the server configuration. The tool neither
changes those cluster-wide settings nor rebuilds existing application indexes.
Run equivalent benchmarks before and after the operator applies those settings,
using new temporary indexes. See [Milvus release notes](https://milvus.io/docs/release_notes.md).

The opt-in automated live test uses an explicit test endpoint:

```sh
LUMIVERSE_MILVUS_TEST_ADDRESS=localhost:19530 bun test src/services/vector-store/providers/milvus.live.test.ts
```

Set corresponding `LUMIVERSE_MILVUS_TEST_DATABASE`, `_USERNAME`, `_PASSWORD`, and
`_SSL` variables when needed. Set `LUMIVERSE_MILVUS_TEST_TEXT=true` to test Text.
Ordinary test runs skip this integration test and never use the application's
normal production connection automatically.
