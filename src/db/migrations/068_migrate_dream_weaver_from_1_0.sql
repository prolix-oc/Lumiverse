-- Migrate Dream Weaver 1.x sessions into the Dream Weaver 2.x message model.

CREATE TABLE IF NOT EXISTS dream_weaver_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dream_text TEXT NOT NULL DEFAULT '',
  tone TEXT,
  constraints TEXT,
  dislikes TEXT,
  persona_id TEXT,
  connection_id TEXT,
  model TEXT,
  draft TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  workspace_kind TEXT NOT NULL DEFAULT 'character',
  character_id TEXT,
  launch_chat_id TEXT,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS dream_weaver_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  tool_name     TEXT,
  status        TEXT,
  supersedes_id TEXT,
  FOREIGN KEY (session_id) REFERENCES dream_weaver_sessions(id) ON DELETE CASCADE
);

CREATE TABLE dream_weaver_messages_migration (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  tool_name     TEXT,
  status        TEXT,
  supersedes_id TEXT
);

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
FROM dream_weaver_messages;

CREATE TABLE dream_weaver_sessions_to_backfill AS
SELECT s.id
FROM dream_weaver_sessions s
WHERE NOT EXISTS (
  SELECT 1
  FROM dream_weaver_messages_migration m
  WHERE m.session_id = s.id
);

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  1,
  'source_card',
  json_object(
    'id', 'dwsrc_' || lower(hex(randomblob(16))),
    'type', 'dream',
    'title', 'Dream',
    'content', s.dream_text,
    'tone', s.tone,
    'constraints', s.constraints,
    'dislikes', s.dislikes
  ),
  NULL,
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE length(trim(COALESCE(s.dream_text, ''))) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  2,
  'tool_card',
  json_object(
    'tool', 'set_name',
    'args', json('{}'),
    'output', json_object('name', json_extract(s.draft, '$.card.name')),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'set_name',
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND length(trim(COALESCE(json_extract(s.draft, '$.card.name'), ''))) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  3,
  'tool_card',
  json_object(
    'tool', 'set_appearance',
    'args', json('{}'),
    'output', json_object(
      'appearance', COALESCE(
        NULLIF(json_extract(s.draft, '$.card.appearance'), ''),
        json_extract(s.draft, '$.card.description')
      ),
      'appearance_data', json(COALESCE(json_extract(s.draft, '$.card.appearance_data'), '{}'))
    ),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'set_appearance',
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND length(trim(COALESCE(
    NULLIF(json_extract(s.draft, '$.card.appearance'), ''),
    json_extract(s.draft, '$.card.description'),
    ''
  ))) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  4,
  'tool_card',
  json_object(
    'tool', 'set_personality',
    'args', json('{}'),
    'output', json_object('personality', json_extract(s.draft, '$.card.personality')),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'set_personality',
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND length(trim(COALESCE(json_extract(s.draft, '$.card.personality'), ''))) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  5,
  'tool_card',
  json_object(
    'tool', 'set_scenario',
    'args', json('{}'),
    'output', json_object('scenario', json_extract(s.draft, '$.card.scenario')),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'set_scenario',
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND length(trim(COALESCE(json_extract(s.draft, '$.card.scenario'), ''))) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  6,
  'tool_card',
  json_object(
    'tool', 'set_voice_guidance',
    'args', json('{}'),
    'output', json_object('voice_guidance', json(json_extract(s.draft, '$.voice_guidance'))),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'set_voice_guidance',
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND json_type(s.draft, '$.voice_guidance') = 'object'
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  7,
  'tool_card',
  json_object(
    'tool', 'set_first_message',
    'args', json('{}'),
    'output', json_object('first_mes', json_extract(s.draft, '$.card.first_mes')),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'set_first_message',
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND length(trim(COALESCE(json_extract(s.draft, '$.card.first_mes'), ''))) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  8,
  'tool_card',
  json_object(
    'tool', 'set_greeting',
    'args', json('{}'),
    'output', json_object('greeting', json_extract(s.draft, '$.greetings[0].content')),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'set_greeting',
  'accepted',
  NULL
FROM dream_weaver_sessions s
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND length(trim(COALESCE(json_extract(s.draft, '$.greetings[0].content'), ''))) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  session_id,
  user_id,
  created_at,
  100 + ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY book_key, entry_key),
  'tool_card',
  payload,
  'add_lorebook_entry',
  'accepted',
  NULL
FROM (
  SELECT
    s.id AS session_id,
    s.user_id AS user_id,
    COALESCE(s.updated_at, unixepoch()) AS created_at,
    lb.key AS book_key,
    entry.key AS entry_key,
    json_object(
      'tool', 'add_lorebook_entry',
      'args', json('{}'),
      'output', json_object(
        'key', CASE
          WHEN json_type(entry.value, '$.keywords') = 'array'
            THEN json(json_extract(entry.value, '$.keywords'))
          WHEN length(trim(COALESCE(json_extract(entry.value, '$.keywords'), ''))) > 0
            THEN json_array(json_extract(entry.value, '$.keywords'))
          ELSE json_array(COALESCE(json_extract(entry.value, '$.comment'), json_extract(entry.value, '$.name'), 'Lore'))
        END,
        'comment', COALESCE(
          NULLIF(json_extract(entry.value, '$.comment'), ''),
          NULLIF(json_extract(entry.value, '$.name'), ''),
          NULLIF(json_extract(entry.value, '$.title'), ''),
          'Lore'
        ),
        'content', COALESCE(json_extract(entry.value, '$.content'), '')
      ),
      'error', NULL,
      'nudge_text', NULL,
      'duration_ms', NULL,
      'token_usage', NULL
    ) AS payload
  FROM dream_weaver_sessions s,
       json_each(s.draft, '$.lorebooks') lb,
       json_each(lb.value, '$.entries') entry
  WHERE json_valid(s.draft)
    AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
    AND length(trim(COALESCE(json_extract(entry.value, '$.content'), ''))) > 0
    AND EXISTS (
      SELECT 1
      FROM dream_weaver_sessions_to_backfill b
      WHERE b.id = s.id
    )
);

INSERT INTO dream_weaver_messages_migration (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  'dwmsg_' || lower(hex(randomblob(16))),
  s.id,
  s.user_id,
  COALESCE(s.updated_at, unixepoch()),
  1000 + npc.key,
  'tool_card',
  json_object(
    'tool', 'add_npc',
    'args', json('{}'),
    'output', json_object(
      'name', json_extract(npc.value, '$.name'),
      'description', trim(
        COALESCE(json_extract(npc.value, '$.description'), '') ||
        CASE
          WHEN length(trim(COALESCE(json_extract(npc.value, '$.appearance'), ''))) > 0
            THEN char(10) || char(10) || 'Appearance: ' || json_extract(npc.value, '$.appearance')
          ELSE ''
        END ||
        CASE
          WHEN length(trim(COALESCE(json_extract(npc.value, '$.personality'), ''))) > 0
            THEN char(10) || char(10) || 'Personality: ' || json_extract(npc.value, '$.personality')
          ELSE ''
        END
      ),
      'voice_notes', json_extract(npc.value, '$.voice')
    ),
    'error', NULL,
    'nudge_text', NULL,
    'duration_ms', NULL,
    'token_usage', NULL
  ),
  'add_npc',
  'accepted',
  NULL
FROM dream_weaver_sessions s,
     json_each(s.draft, '$.npc_definitions') npc
WHERE json_valid(s.draft)
  AND json_extract(s.draft, '$.format') = 'DW_DRAFT_V1'
  AND length(trim(COALESCE(json_extract(npc.value, '$.name'), ''))) > 0
  AND length(trim(
    COALESCE(json_extract(npc.value, '$.description'), '') ||
    COALESCE(json_extract(npc.value, '$.appearance'), '') ||
    COALESCE(json_extract(npc.value, '$.personality'), '')
  )) > 0
  AND EXISTS (
    SELECT 1
    FROM dream_weaver_sessions_to_backfill b
    WHERE b.id = s.id
  );

DROP TABLE dream_weaver_messages;

ALTER TABLE dream_weaver_sessions RENAME TO dream_weaver_sessions_1_0;

CREATE TABLE dream_weaver_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dream_text TEXT NOT NULL DEFAULT '',
  tone TEXT,
  constraints TEXT,
  dislikes TEXT,
  persona_id TEXT,
  connection_id TEXT,
  model TEXT,
  draft TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  workspace_kind TEXT NOT NULL DEFAULT 'character',
  character_id TEXT,
  launch_chat_id TEXT,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
  FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
);

INSERT INTO dream_weaver_sessions (
  id,
  user_id,
  created_at,
  updated_at,
  dream_text,
  tone,
  constraints,
  dislikes,
  persona_id,
  connection_id,
  model,
  draft,
  status,
  workspace_kind,
  character_id,
  launch_chat_id
)
SELECT
  id,
  user_id,
  COALESCE(created_at, unixepoch()),
  COALESCE(updated_at, unixepoch()),
  COALESCE(dream_text, ''),
  tone,
  constraints,
  dislikes,
  persona_id,
  connection_id,
  model,
  draft,
  COALESCE(status, 'draft'),
  CASE
    WHEN json_valid(draft) AND json_extract(draft, '$.kind') = 'scenario' THEN 'scenario'
    ELSE 'character'
  END,
  character_id,
  NULL
FROM dream_weaver_sessions_1_0;

DROP TABLE dream_weaver_sessions_1_0;

CREATE TABLE dream_weaver_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  tool_name     TEXT,
  status        TEXT,
  supersedes_id TEXT,
  FOREIGN KEY (session_id) REFERENCES dream_weaver_sessions(id) ON DELETE CASCADE
);

INSERT INTO dream_weaver_messages (
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
)
SELECT
  id,
  session_id,
  user_id,
  created_at,
  seq,
  kind,
  payload,
  tool_name,
  status,
  supersedes_id
FROM dream_weaver_messages_migration
WHERE EXISTS (
  SELECT 1
  FROM dream_weaver_sessions s
  WHERE s.id = dream_weaver_messages_migration.session_id
);

DROP TABLE dream_weaver_messages_migration;
DROP TABLE dream_weaver_sessions_to_backfill;

CREATE INDEX IF NOT EXISTS idx_dw_sessions_user
  ON dream_weaver_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dw_sessions_status
  ON dream_weaver_sessions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_dwm_session_seq
  ON dream_weaver_messages(session_id, seq);

CREATE INDEX IF NOT EXISTS idx_dwm_session_status
  ON dream_weaver_messages(session_id, status)
  WHERE kind = 'tool_card';
