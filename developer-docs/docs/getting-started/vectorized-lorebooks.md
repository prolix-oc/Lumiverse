# Vectorized Lorebooks

Vectorized lorebooks let Lumiverse activate world-book entries based on semantic similarity, not just keyword hits. If an entry is not injecting, walk through the chain below in order.

## Safe Workflow

1. Attach the world book.
2. Enable and test embeddings.
3. Turn on world-book vectorization.
4. Mark the entries you want to use for semantic activation.
5. Reindex the book.
6. Verify activation in World Info feedback or Prompt Dry Run.

If you skip any step, semantic activation can fail silently.

## 1. Attach The Book

Vector retrieval only runs against world books that are attached to the current chat context.

- Standalone imports are not attached automatically. Attach them to the current character, the active persona, or global world books.
- Character-card lorebook imports are attached to that character automatically.
- Global world books are configured separately and apply everywhere.

If the book is not attached, it will not inject through vectorization even if indexing succeeded.

## 2. Enable And Test Embeddings

Open `Settings -> Embeddings` and confirm all of these are true:

- Embeddings are enabled.
- An API key is configured.
- The embedding test passes.
- Dimensions are detected.
- World-book vectorization is enabled.

If the test has never passed, the app may have semantic activation enabled on entries without a usable embedding configuration behind it.

## 3. Turn On Semantic Activation For Entries

Each entry has its own semantic activation toggle.

- Open the entry.
- Turn on `Use for semantic activation`.
- Make sure the entry is not disabled.
- Make sure the entry has real content.

The per-entry status badge tells you whether the entry is:

- `Not enabled`
- `Pending`
- `Indexed`
- `Error`

## 4. Reindex After Changes

Turning on semantic activation and actually indexing the entry are different steps.

After changing any of these fields, reindex the world book:

- semantic activation toggle
- entry content
- disabled state

Reindexing updates the per-entry status and removes stale vectors for entries that should no longer be searchable.

## 5. Verify Activation

Use one of these tools after reindexing:

- `World Info` feedback in the chat UI
- `Prompt Dry Run`
- `Diagnose Current Chat` in the world-book panel

These views show:

- keyword activations
- vector activations
- the vector query preview built from recent visible chat messages
- blockers such as missing attachments or embeddings not being ready

## Important Behavior

Vector lorebook retrieval depends on recent visible chat context.

That means:

- a brand new chat may have no useful query context yet
- a very short or vague recent exchange may return no vector hits
- hidden messages are not used to build the vector query preview

If indexing succeeded but you still get no hits, the problem may be the current chat context rather than the entry itself.

## Symptom Guide

### "The book never injects"

Possible causes:

- the book is not attached
- embeddings are disabled
- the API key is missing
- embeddings were never tested successfully
- world-book vectorization is disabled

### "The entry says pending forever"

Possible causes:

- the book was never reindexed
- embeddings are not ready
- the entry is disabled
- the entry content is empty

### "The entry is indexed but still does not inject"

Possible causes:

- the current chat does not provide useful recent context
- the similarity threshold is too strict
- the book is attached, but a different book is actually the one matching the current context better
- world-info budget or minimum-priority settings are crowding the entry out

### "Keyword injection works, vector injection does not"

Possible causes:

- the entry was never marked for semantic activation
- the entry was marked, but not reindexed afterward
- embeddings are working, but world-book vectorization is disabled

## Recommended Troubleshooting Order

When something feels wrong, check in this exact order:

1. Is the book attached to the current character, active persona, or global books?
2. Are embeddings enabled, tested, and dimensioned?
3. Is world-book vectorization enabled?
4. Is the entry set to `Use for semantic activation`?
5. Is the entry enabled and non-empty?
6. Has the book been reindexed since the last semantic change?
7. Does `Diagnose Current Chat` show a useful query preview and any blockers?

Following that order usually finds the issue quickly.
