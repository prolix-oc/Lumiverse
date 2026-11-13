-- Memory Cortex: Vault chunk snapshots.
-- Vaults are now self-contained salience sources. When a vault is created
-- (or reindexed), the source chat's vectorized chunks are snapshotted here
-- and their LanceDB embedding rows are copied under source_type='vault_chunk',
-- owner_id=<vaultId>. This decouples vault retrieval from the source chat
-- and eliminates the cortexResultCache pollution that happened when
-- queryLinkedCortex ran queryCortex() against the source chat directly.
--
-- chunk_count on cortex_vaults mirrors the row count here. A sentinel value
-- of -1 means "auto-reindex attempted but source chat is gone" so we don't
-- retry on every generation.

CREATE TABLE IF NOT EXISTS cortex_vault_chunks (
  id                  TEXT PRIMARY KEY,
  vault_id            TEXT NOT NULL,
  source_chunk_id     TEXT NOT NULL,
  content             TEXT NOT NULL,
  salience_score      REAL,
  emotional_tags      TEXT DEFAULT '[]',     -- JSON array
  entity_names        TEXT DEFAULT '[]',     -- JSON array; names (not ids)
  source_created_at   INTEGER NOT NULL,
  copied_at           INTEGER NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cvc_vault ON cortex_vault_chunks(vault_id);
CREATE INDEX IF NOT EXISTS idx_cvc_salience ON cortex_vault_chunks(vault_id, salience_score DESC);

-- Add chunk_count to cortex_vaults. Existing rows default to 0; the
-- queryLinkedCortex auto-reindex path will pick them up on first query.
ALTER TABLE cortex_vaults ADD COLUMN chunk_count INTEGER DEFAULT 0;
