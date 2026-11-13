-- Add per-swipe timestamps (parallel JSON array to swipes)
ALTER TABLE messages ADD COLUMN swipe_dates TEXT NOT NULL DEFAULT '[]';

-- Backfill: existing messages get send_date for each swipe
UPDATE messages SET swipe_dates = (
  SELECT '[' || group_concat(send_date, ',') || ']'
  FROM (
    SELECT send_date FROM json_each(messages.swipes)
  )
);
