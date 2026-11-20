-- Tokenizer configuration (global, no user_id)
CREATE TABLE IF NOT EXISTS tokenizer_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'openai' | 'huggingface' | 'tiktoken' | 'approximate'
  config TEXT NOT NULL DEFAULT '{}',
  is_built_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Model-to-tokenizer matching patterns (global)
CREATE TABLE IF NOT EXISTS tokenizer_model_patterns (
  id TEXT PRIMARY KEY,
  tokenizer_id TEXT NOT NULL REFERENCES tokenizer_configs(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  is_built_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tokenizer_model_patterns_tokenizer ON tokenizer_model_patterns(tokenizer_id);
CREATE INDEX IF NOT EXISTS idx_tokenizer_model_patterns_priority ON tokenizer_model_patterns(priority DESC);

-- Prompt breakdown storage per message
CREATE TABLE IF NOT EXISTS message_breakdowns (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_message_breakdowns_chat ON message_breakdowns(chat_id);
