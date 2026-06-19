-- Track peak chunk salience per entity (highest single-chunk salience ever recorded).
-- Backfill from current salience_avg as best available approximation for existing data.
ALTER TABLE memory_entities ADD COLUMN salience_peak REAL DEFAULT 0.0;
UPDATE memory_entities SET salience_peak = salience_avg WHERE salience_avg > 0;
