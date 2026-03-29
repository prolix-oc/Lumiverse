-- Heuristics Engine: Entity enhancements for fact extraction tracking,
-- salience breakdown, and NP chunker support
-- Adds fields for: BUG 4 (fact extraction status), IMP 2 (salience cause tagging),
-- IMP 4 (NP chunker provisional entities)

ALTER TABLE memory_entities ADD COLUMN fact_extraction_status TEXT DEFAULT 'never';
ALTER TABLE memory_entities ADD COLUMN fact_extraction_last_attempt INTEGER;
ALTER TABLE memory_entities ADD COLUMN salience_breakdown TEXT DEFAULT '{"mentionComponent":0,"arcComponent":0,"graphComponent":0,"total":0}';
ALTER TABLE memory_entities ADD COLUMN last_mention_timestamp INTEGER;
ALTER TABLE memory_entities ADD COLUMN recent_mention_count INTEGER DEFAULT 0;
ALTER TABLE memory_entities ADD COLUMN confidence TEXT DEFAULT 'confirmed';

-- Index for fact extraction gating: find entities needing extraction
CREATE INDEX IF NOT EXISTS idx_me_fact_status ON memory_entities(chat_id, fact_extraction_status, salience_avg);
-- Index for provisional entity cleanup
CREATE INDEX IF NOT EXISTS idx_me_confidence ON memory_entities(chat_id, confidence);

-- Backfill fact_extraction_status from existing data
-- Entities with facts → 'ok', entities with 0 facts → 'never'
UPDATE memory_entities SET fact_extraction_status = 'ok'
  WHERE json_array_length(facts) > 0 AND facts != '[]';

-- Backfill last_mention_timestamp from last_seen_at
UPDATE memory_entities SET last_mention_timestamp = last_seen_at WHERE last_seen_at IS NOT NULL;

-- Backfill salience_breakdown with approximations (total = current salience, split evenly)
UPDATE memory_entities SET salience_breakdown = json_object(
  'mentionComponent', salience_avg * 0.5,
  'arcComponent', salience_avg * 0.5,
  'graphComponent', 0.0,
  'total', salience_avg
) WHERE salience_avg > 0;
