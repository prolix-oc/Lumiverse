-- Chat chunks table: stores conversation chunks for incremental vectorization
-- Each chunk represents a semantic unit of conversation (user + assistant turn)
CREATE TABLE IF NOT EXISTS chat_chunks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  vectorized_at INTEGER,
  vector_model TEXT,
  retrieval_count INTEGER DEFAULT 0,
  last_retrieved_at INTEGER,
  avg_similarity_score REAL,
  has_dialogue INTEGER DEFAULT 1,
  has_action INTEGER DEFAULT 0,
  message_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_chunks_chat ON chat_chunks(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_chunks_end_message ON chat_chunks(end_message_id);
CREATE INDEX IF NOT EXISTS idx_chat_chunks_vectorized ON chat_chunks(chat_id, vectorized_at);

-- Query vector cache: stores frequently used query vectors to avoid re-embedding
CREATE TABLE IF NOT EXISTS query_vector_cache (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  query_text TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_query_cache_chat_hash ON query_vector_cache(chat_id, query_hash);
CREATE INDEX IF NOT EXISTS idx_query_cache_expires ON query_vector_cache(expires_at);
