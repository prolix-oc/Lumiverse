-- Memory Cortex: Hierarchical memory summaries (Raw → Consolidated → Arc)
CREATE TABLE IF NOT EXISTS memory_consolidations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    tier INTEGER NOT NULL DEFAULT 1,
    title TEXT,
    summary TEXT NOT NULL,
    source_chunk_ids TEXT DEFAULT '[]',
    source_consolidation_ids TEXT DEFAULT '[]',
    entity_ids TEXT DEFAULT '[]',
    message_range_start INTEGER,
    message_range_end INTEGER,
    time_range_start INTEGER,
    time_range_end INTEGER,
    salience_avg REAL DEFAULT 0.0,
    emotional_tags TEXT DEFAULT '[]',
    token_count INTEGER DEFAULT 0,
    vectorized_at INTEGER,
    vector_model TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mc_chat_tier ON memory_consolidations(chat_id, tier);
CREATE INDEX IF NOT EXISTS idx_mc_chat_range ON memory_consolidations(chat_id, message_range_start, message_range_end);
CREATE INDEX IF NOT EXISTS idx_mc_vectorized ON memory_consolidations(chat_id, vectorized_at);
