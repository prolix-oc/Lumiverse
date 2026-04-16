-- Memory Cortex: Font/dialogue color attribution per character
CREATE TABLE IF NOT EXISTS memory_font_colors (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    entity_id TEXT,
    hex_color TEXT NOT NULL,
    usage_type TEXT DEFAULT 'unknown',
    confidence REAL DEFAULT 0.0,
    sample_count INTEGER DEFAULT 0,
    sample_excerpt TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES memory_entities(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mfc_chat ON memory_font_colors(chat_id);
CREATE INDEX IF NOT EXISTS idx_mfc_chat_color ON memory_font_colors(chat_id, hex_color);
CREATE INDEX IF NOT EXISTS idx_mfc_entity ON memory_font_colors(entity_id);
