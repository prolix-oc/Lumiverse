CREATE TABLE illarin_delivery_receipt_new (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  content_generation INTEGER NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  PRIMARY KEY (user_id, instance_id, delivery_id)
);

INSERT INTO illarin_delivery_receipt_new
  (user_id, instance_id, delivery_id, asset_id, content_generation, installed_at, acknowledged_at)
SELECT user_id, instance_id, delivery_id, asset_id, content_generation, installed_at, acknowledged_at
FROM illarin_delivery_receipt;

DROP TABLE illarin_delivery_receipt;
ALTER TABLE illarin_delivery_receipt_new RENAME TO illarin_delivery_receipt;

CREATE INDEX idx_illarin_delivery_receipt_pending
ON illarin_delivery_receipt(user_id, instance_id, acknowledged_at);
