-- Durable Illarin delivery receipts for installations created by migration
-- 109 as well as fresh databases. A receipt is written only after installation;
-- acknowledgement is recorded after a later collect request succeeds.
CREATE TABLE IF NOT EXISTS illarin_delivery_receipt (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  content_generation INTEGER NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  PRIMARY KEY (user_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_illarin_delivery_receipt_pending
ON illarin_delivery_receipt(user_id, instance_id, acknowledged_at);
