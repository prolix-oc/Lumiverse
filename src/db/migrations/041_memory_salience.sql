-- Memory Cortex: Per-chunk salience scoring and emotional tagging
CREATE TABLE IF NOT EXISTS memory_salience (
    id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0.0,
    score_source TEXT DEFAULT 'heuristic',
    emotional_tags TEXT DEFAULT '[]',
    status_changes TEXT DEFAULT '[]',
    narrative_flags TEXT DEFAULT '[]',
    has_dialogue INTEGER DEFAULT 0,
    has_action INTEGER DEFAULT 0,
    has_internal_thought INTEGER DEFAULT 0,
    word_count INTEGER DEFAULT 0,
    scored_at INTEGER NOT NULL,
    scored_by TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES chat_chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ms_chat ON memory_salience(chat_id);
CREATE INDEX IF NOT EXISTS idx_ms_chat_score ON memory_salience(chat_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_ms_chunk ON memory_salience(chunk_id);
