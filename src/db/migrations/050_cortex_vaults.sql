-- Memory Cortex: Vault & Interlink tables
-- Vaults are frozen snapshots of a chat's cortex state (entities + relations).
-- Chat links attach vaults (read-only) or interlinks (live) to chats for
-- cross-chat memory sharing during prompt assembly.

-- ─── Vaults ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cortex_vaults (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  source_chat_id  TEXT,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  entity_count    INTEGER DEFAULT 0,
  relation_count  INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (source_chat_id) REFERENCES chats(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cortex_vaults_user ON cortex_vaults(user_id);

-- ─── Vault Entities (frozen snapshot) ────────────────────────────

CREATE TABLE IF NOT EXISTS cortex_vault_entities (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  aliases           TEXT DEFAULT '[]',
  description       TEXT DEFAULT '',
  status            TEXT DEFAULT 'active',
  facts             TEXT DEFAULT '[]',
  emotional_valence TEXT DEFAULT '{}',
  salience_avg      REAL DEFAULT 0.0,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cve_vault ON cortex_vault_entities(vault_id);

-- ─── Vault Relations (denormalized entity names) ─────────────────

CREATE TABLE IF NOT EXISTS cortex_vault_relations (
  id                  TEXT PRIMARY KEY,
  vault_id            TEXT NOT NULL,
  source_entity_name  TEXT NOT NULL,
  target_entity_name  TEXT NOT NULL,
  relation_type       TEXT NOT NULL,
  relation_label      TEXT,
  strength            REAL DEFAULT 0.5,
  sentiment           REAL DEFAULT 0.0,
  status              TEXT DEFAULT 'active',
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cvr_vault ON cortex_vault_relations(vault_id);

-- ─── Chat Links (vault attachments & interlinks) ─────────────────

CREATE TABLE IF NOT EXISTS cortex_chat_links (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  link_type       TEXT NOT NULL CHECK(link_type IN ('vault', 'interlink')),
  vault_id        TEXT,
  target_chat_id  TEXT,
  label           TEXT DEFAULT '',
  enabled         INTEGER DEFAULT 1,
  priority        INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id) REFERENCES cortex_vaults(id) ON DELETE CASCADE,
  FOREIGN KEY (target_chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ccl_chat ON cortex_chat_links(chat_id);
CREATE INDEX IF NOT EXISTS idx_ccl_user ON cortex_chat_links(user_id);
