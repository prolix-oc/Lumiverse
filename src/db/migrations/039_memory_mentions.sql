-- Memory Cortex: Junction table — which entities appear in which chunks
CREATE TABLE IF NOT EXISTS memory_mentions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    role TEXT DEFAULT 'present',
    excerpt TEXT,
    sentiment REAL DEFAULT 0.0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (chunk_id) REFERENCES chat_chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mm_entity ON memory_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mm_chunk ON memory_mentions(chunk_id);
CREATE INDEX IF NOT EXISTS idx_mm_chat_entity ON memory_mentions(chat_id, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_entity_chunk ON memory_mentions(entity_id, chunk_id);
