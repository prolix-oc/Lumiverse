-- Memory Cortex: Persistent entity nodes extracted from narrative
CREATE TABLE IF NOT EXISTS memory_entities (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'character',
    aliases TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    first_seen_chunk_id TEXT,
    last_seen_chunk_id TEXT,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    mention_count INTEGER DEFAULT 0,
    salience_avg REAL DEFAULT 0.0,
    status TEXT DEFAULT 'active',
    status_changed_at INTEGER,
    facts TEXT DEFAULT '[]',
    emotional_valence TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_me_chat ON memory_entities(chat_id);
CREATE INDEX IF NOT EXISTS idx_me_chat_type ON memory_entities(chat_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_me_chat_name ON memory_entities(chat_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_me_status ON memory_entities(chat_id, status);
