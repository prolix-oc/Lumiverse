-- Heuristics Engine: Edge enhancements for contradiction detection, decay, and consolidation
-- Adds fields for: BUG 3 (contradiction tracking), IMP 1 (independent edge decay),
-- IMP 5 (edge type consolidation/merge tracking)

ALTER TABLE memory_relations ADD COLUMN contradiction_flag TEXT DEFAULT 'none';
ALTER TABLE memory_relations ADD COLUMN contradiction_peer_id TEXT;
ALTER TABLE memory_relations ADD COLUMN sentiment_range TEXT;
ALTER TABLE memory_relations ADD COLUMN superseded_by TEXT;
ALTER TABLE memory_relations ADD COLUMN arc_ids TEXT DEFAULT '[]';
ALTER TABLE memory_relations ADD COLUMN first_seen_arc_id TEXT;
ALTER TABLE memory_relations ADD COLUMN last_seen_arc_id TEXT;
ALTER TABLE memory_relations ADD COLUMN last_evidence_timestamp INTEGER;
ALTER TABLE memory_relations ADD COLUMN decay_rate REAL DEFAULT 0.05;
ALTER TABLE memory_relations ADD COLUMN edge_salience REAL DEFAULT 0.0;
ALTER TABLE memory_relations ADD COLUMN label_aliases TEXT DEFAULT '[]';
ALTER TABLE memory_relations ADD COLUMN canonical_edge_id TEXT;
ALTER TABLE memory_relations ADD COLUMN merged_into TEXT;

-- Index for filtering out superseded/suspect edges in standard retrieval
CREATE INDEX IF NOT EXISTS idx_mr_contradiction ON memory_relations(chat_id, contradiction_flag);
-- Index for edge salience filtering
CREATE INDEX IF NOT EXISTS idx_mr_edge_salience ON memory_relations(chat_id, edge_salience);
-- Index for merged edge lookup
CREATE INDEX IF NOT EXISTS idx_mr_merged ON memory_relations(merged_into);

-- Backfill: set last_evidence_timestamp from last_reinforced_at where available
UPDATE memory_relations SET last_evidence_timestamp = last_reinforced_at WHERE last_reinforced_at IS NOT NULL;
UPDATE memory_relations SET last_evidence_timestamp = created_at WHERE last_evidence_timestamp IS NULL;

-- Backfill: set edge_salience = strength as starting approximation
UPDATE memory_relations SET edge_salience = strength;
