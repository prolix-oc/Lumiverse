-- Memory Cortex: Directed relationship edges between entities
CREATE TABLE IF NOT EXISTS memory_relations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    relation_label TEXT,
    strength REAL DEFAULT 0.5,
    sentiment REAL DEFAULT 0.0,
    evidence_chunk_ids TEXT DEFAULT '[]',
    first_established_at INTEGER,
    last_reinforced_at INTEGER,
    status TEXT DEFAULT 'active',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (source_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mr_chat ON memory_relations(chat_id);
CREATE INDEX IF NOT EXISTS idx_mr_source ON memory_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_mr_target ON memory_relations(target_entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mr_pair_type ON memory_relations(source_entity_id, target_entity_id, relation_type);
