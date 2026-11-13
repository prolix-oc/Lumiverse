-- A persisted high-water mark avoids replaying cues after retries, token
-- rotation, restarts, or council/provider phase regressions.
ALTER TABLE ios_live_activities ADD COLUMN delivered_stage INTEGER NOT NULL DEFAULT -1;
UPDATE ios_live_activities SET delivered_stage = CASE
  WHEN delivered_phase IN ('assembling', 'council', 'waiting') THEN 0
  WHEN delivered_phase = 'reasoning' THEN 1
  WHEN delivered_phase = 'streaming' THEN 2
  WHEN delivered_phase = 'completed' THEN 3
  WHEN delivered_phase = 'error' THEN 4
  ELSE -1 END;
