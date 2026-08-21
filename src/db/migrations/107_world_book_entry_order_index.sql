-- Serves the default lorebook navigation query without re-sorting every page.
CREATE INDEX IF NOT EXISTS idx_wbe_world_book_order
  ON world_book_entries(world_book_id, order_value, id);
