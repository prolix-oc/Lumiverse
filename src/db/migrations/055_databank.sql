-- Databank: user document storage with chunking and vectorization

CREATE TABLE IF NOT EXISTS databanks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL CHECK(scope IN ('global', 'character', 'chat')),
  scope_id    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_databanks_user ON databanks(user_id);
CREATE INDEX IF NOT EXISTS idx_databanks_scope ON databanks(user_id, scope, scope_id);

CREATE TABLE IF NOT EXISTS databank_documents (
  id            TEXT PRIMARY KEY,
  databank_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT '',
  file_size     INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL DEFAULT '',
  total_chunks  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'ready', 'error')),
  error_message TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (databank_id) REFERENCES databanks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_databank_docs_bank ON databank_documents(databank_id);
CREATE INDEX IF NOT EXISTS idx_databank_docs_user ON databank_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_databank_docs_slug ON databank_documents(user_id, slug);

CREATE TABLE IF NOT EXISTS databank_chunks (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,
  databank_id   TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  token_count   INTEGER NOT NULL DEFAULT 0,
  vectorized_at INTEGER,
  vector_model  TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES databank_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (databank_id) REFERENCES databanks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_databank_chunks_doc ON databank_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_databank_chunks_bank ON databank_chunks(databank_id);
CREATE INDEX IF NOT EXISTS idx_databank_chunks_user ON databank_chunks(user_id);
