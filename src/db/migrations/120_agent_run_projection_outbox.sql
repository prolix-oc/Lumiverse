-- Durable terminal projection outbox delivery state.
-- Events remain public-schema compatible; delivery metadata is operational and
-- never restored from account archives.
ALTER TABLE agent_chat_events
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(delivery_state IN ('pending', 'leased', 'delivered'));

ALTER TABLE agent_chat_events
  ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0
    CHECK(delivery_attempts >= 0 AND delivery_attempts <= 100000);

ALTER TABLE agent_chat_events
  ADD COLUMN delivery_lease_token TEXT
    CHECK(delivery_lease_token IS NULL OR length(delivery_lease_token) BETWEEN 1 AND 256);

ALTER TABLE agent_chat_events
  ADD COLUMN delivery_lease_expires_at INTEGER
    CHECK(delivery_lease_expires_at IS NULL OR delivery_lease_expires_at >= 0);

ALTER TABLE agent_chat_events
  ADD COLUMN delivered_at INTEGER
    CHECK(delivered_at IS NULL OR delivered_at >= 0);

CREATE INDEX IF NOT EXISTS idx_agent_chat_events_terminal_delivery
  ON agent_chat_events(event_kind, delivery_state, delivery_lease_expires_at, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_chat_events_delivery_cleanup
  ON agent_chat_events(user_id, chat_id, delivered_at, sequence);
