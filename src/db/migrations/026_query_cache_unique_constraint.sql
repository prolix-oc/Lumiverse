-- Add unique constraint on (chat_id, query_hash) for query vector cache
CREATE UNIQUE INDEX IF NOT EXISTS idx_query_cache_chat_hash_unique ON query_vector_cache(chat_id, query_hash);
