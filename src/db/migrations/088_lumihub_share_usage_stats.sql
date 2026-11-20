-- Opt-in flag for sharing anonymous daily usage counters.
ALTER TABLE lumihub_link ADD COLUMN share_usage_stats INTEGER NOT NULL DEFAULT 0;
