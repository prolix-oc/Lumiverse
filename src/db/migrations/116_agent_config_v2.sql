-- Normalized AgentConfig V2. Legacy metadata is read exactly once here; runtime
-- readers use these tables and never consult metadata.agentConfig.

CREATE UNIQUE INDEX IF NOT EXISTS idx_presets_user_id_id
  ON presets(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_user_id_id
  ON chats(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_profiles_user_id_id
  ON connection_profiles(user_id, id);

CREATE TABLE IF NOT EXISTS preset_agent_configs (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 2 CHECK (version = 2),
  agents_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agents_enabled IN (0, 1)),
  allowed_modes TEXT NOT NULL DEFAULT '["response"]' CHECK (json_valid(allowed_modes)),
  default_mode TEXT NOT NULL DEFAULT 'response' CHECK (default_mode IN ('response', 'agentic')),
  max_invocations INTEGER NOT NULL DEFAULT 64 CHECK (max_invocations BETWEEN 1 AND 9007199254740991),
  max_tool_calls INTEGER NOT NULL DEFAULT 64 CHECK (max_tool_calls BETWEEN 1 AND 9007199254740991),
  main_tool_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(main_tool_ids)),
  main_lore_scope TEXT NOT NULL DEFAULT 'active' CHECK (main_lore_scope IN ('active', 'all_owned')),
  phase_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(phase_policy_json)),
  cognition_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cognition_policy_json)),
  task_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(task_policy_json)),
  workspace_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(workspace_policy_json)),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'review_required', 'repair_required')),
  review_code TEXT,
  config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id),
  FOREIGN KEY (user_id, preset_id) REFERENCES presets(user_id, id) ON DELETE CASCADE
);

-- Explicit review acknowledgement is separate from repair state; imported rows
-- cannot regain authority merely by being copied.
ALTER TABLE preset_agent_configs ADD COLUMN review_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (review_acknowledged IN (0, 1));
ALTER TABLE preset_agent_configs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json));

ALTER TABLE preset_agent_configs ADD COLUMN binding_revision INTEGER NOT NULL DEFAULT 1 CHECK (binding_revision BETWEEN 1 AND 9007199254740991);

CREATE TABLE IF NOT EXISTS preset_agent_connection_slots (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  slot_id TEXT NOT NULL CHECK (slot_id GLOB '[a-z]*' AND length(slot_id) <= 128),
  label TEXT NOT NULL CHECK (length(label) <= 80),
  required_capabilities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_capabilities)),
  slot_revision INTEGER NOT NULL DEFAULT 1 CHECK (slot_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id, slot_id),
  FOREIGN KEY (user_id, preset_id) REFERENCES preset_agent_configs(user_id, preset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS preset_agent_profiles (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) <= 80),
  system_prompt TEXT NOT NULL CHECK (length(CAST(system_prompt AS BLOB)) <= 32768),
  connection_ref_kind TEXT NOT NULL CHECK (connection_ref_kind IN ('inherit_main', 'slot')),
  slot_id TEXT,
  tool_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_ids)),
  workspace_capabilities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(workspace_capabilities)),
  lore_scope TEXT NOT NULL CHECK (lore_scope IN ('active', 'all_owned')),
  allow_main_delegation INTEGER NOT NULL CHECK (allow_main_delegation IN (0, 1)),
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('required', 'optional')),
  stream_activity INTEGER NOT NULL CHECK (stream_activity IN (0, 1)),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 8192),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 5000 AND timeout_ms % 1000 = 0),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id, profile_id),
  FOREIGN KEY (user_id, preset_id) REFERENCES preset_agent_configs(user_id, preset_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, preset_id, slot_id) REFERENCES preset_agent_connection_slots(user_id, preset_id, slot_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS preset_agent_slot_bindings (
  user_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  connection_id TEXT,
  binding_revision INTEGER NOT NULL DEFAULT 1 CHECK (binding_revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'review_required', 'repair_required')),
  review_code TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, preset_id, slot_id),
  FOREIGN KEY (user_id, preset_id, slot_id) REFERENCES preset_agent_connection_slots(user_id, preset_id, slot_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, connection_id) REFERENCES connection_profiles(user_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS chat_agent_mode_overrides (
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  mode TEXT CHECK (mode IS NULL OR mode IN ('response', 'agentic')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'review_required', 'repair_required')),
  review_code TEXT,
  review_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (review_acknowledged IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, chat_id),
  FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
);

DROP TABLE IF EXISTS temp._agent_config_v1_validation;
CREATE TEMP TABLE _agent_config_v1_validation AS
WITH preset_json AS (
  SELECT p.*,
    CASE WHEN json_valid(p.metadata) THEN 1 ELSE 0 END AS metadata_valid,
    CASE WHEN json_valid(p.metadata) THEN p.metadata ELSE '{}' END AS metadata_json,
    CASE WHEN json_valid(p.metadata)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(p.metadata) AS metadata_field
        GROUP BY metadata_field.key
        HAVING COUNT(*) > 1
      )
      THEN 1 ELSE 0 END AS metadata_keys_unique
  FROM presets AS p
), legacy AS (
  SELECT user_id, id AS preset_id,
    CASE WHEN metadata_valid = 0 OR json_type(metadata_json, '$.agentConfig') IS NOT NULL THEN 1 ELSE 0 END AS has_config,
    metadata_valid,
    metadata_keys_unique,
    CASE WHEN json_type(metadata_json, '$.agentConfig') = 'object'
      THEN json_extract(metadata_json, '$.agentConfig') ELSE '{}' END AS config_json
  FROM preset_json
), shaped AS (
  SELECT *,
    CASE WHEN json_type(config_json, '$.profiles') = 'array'
      THEN json_extract(config_json, '$.profiles') ELSE '[]' END AS profiles_json,
    CASE WHEN json_type(config_json, '$.mainToolIds') = 'array'
      THEN json_extract(config_json, '$.mainToolIds') ELSE '[]' END AS main_tools_json
  FROM legacy
), profile_validity AS (
  SELECT shaped.*,
    NOT EXISTS (
      SELECT 1
      FROM json_each(profiles_json) AS profile
      WHERE COALESCE(NOT (
        profile.type = 'object'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN profile.type = 'object' THEN profile.value ELSE '{}' END) AS profile_field
          GROUP BY profile_field.key
          HAVING COUNT(*) > 1
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.id') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN length(json_extract(profile.value, '$.id')) ELSE NULL END BETWEEN 1 AND 64
        AND CASE WHEN profile.type = 'object' THEN substr(json_extract(profile.value, '$.id'), 1, 1) ELSE NULL END GLOB '[a-z]'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.id') ELSE NULL END NOT GLOB '*[^a-z0-9_]*'
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.name') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN length(json_extract(profile.value, '$.name')) ELSE NULL END <= 80
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.systemPrompt') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN length(CAST(json_extract(profile.value, '$.systemPrompt') AS BLOB)) ELSE NULL END <= 32768
        AND EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN profile.type = 'object' THEN profile.value ELSE '{}' END) AS required
          WHERE required.key = 'connectionProfileId'
        )
        AND (
          CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.connectionProfileId') ELSE NULL END = 'null'
          OR (
            CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.connectionProfileId') ELSE NULL END = 'text'
            AND CASE WHEN profile.type = 'object' THEN length(json_extract(profile.value, '$.connectionProfileId')) ELSE NULL END BETWEEN 1 AND 512
          )
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            CASE
              WHEN profile.type = 'object'
                AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
              THEN json_extract(profile.value, '$.toolIds')
              ELSE '[]'
            END
          ) AS tool
          WHERE tool.type <> 'text'
            OR tool.value NOT IN (
              'lore_list_books', 'lore_get_book', 'lore_list_entries',
              'lore_get_entry', 'lore_search_entries', 'chat_search_history'
            )
        )
        AND NOT EXISTS (
          SELECT tool.value
          FROM json_each(
            CASE
              WHEN profile.type = 'object'
                AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
              THEN json_extract(profile.value, '$.toolIds')
              ELSE '[]'
            END
          ) AS tool
          GROUP BY tool.value
          HAVING COUNT(*) > 1
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.loreScope') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.loreScope') ELSE NULL END IN ('active', 'all_owned')
        AND (
          CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.loreScope') ELSE NULL END <> 'all_owned'
          OR EXISTS (
            SELECT 1
            FROM json_each(
              CASE
                WHEN profile.type = 'object'
                  AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.toolIds') ELSE NULL END = 'array'
                THEN json_extract(profile.value, '$.toolIds')
                ELSE '[]'
              END
            ) AS tool
            WHERE tool.value IN (
              'lore_list_books', 'lore_get_book', 'lore_list_entries',
              'lore_get_entry', 'lore_search_entries'
            )
          )
        )
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.allowMainDelegation') ELSE NULL END IN ('true', 'false')
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.failurePolicy') ELSE NULL END = 'text'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.failurePolicy') ELSE NULL END IN ('required', 'optional')
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.streamActivity') ELSE NULL END IN ('true', 'false')
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.maxOutputTokens') ELSE NULL END = 'integer'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.maxOutputTokens') ELSE NULL END BETWEEN 64 AND 8192
        AND CASE WHEN profile.type = 'object' THEN json_type(profile.value, '$.timeoutMs') ELSE NULL END = 'integer'
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.timeoutMs') ELSE NULL END >= 5000
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.timeoutMs') ELSE NULL END <= 9007199254740991
        AND CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.timeoutMs') ELSE NULL END % 1000 = 0
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN profile.type = 'object' THEN profile.value ELSE '{}' END) AS field
          WHERE field.key NOT IN (
            'id', 'name', 'systemPrompt', 'connectionProfileId', 'toolIds',
            'loreScope', 'allowMainDelegation', 'failurePolicy',
            'streamActivity', 'maxOutputTokens', 'timeoutMs'
          )
        )
      ), 1)
    ) AS profiles_valid,
    NOT EXISTS (
      SELECT CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.id') ELSE NULL END
      FROM json_each(profiles_json) AS profile
      GROUP BY CASE WHEN profile.type = 'object' THEN json_extract(profile.value, '$.id') ELSE NULL END
      HAVING COUNT(*) > 1
    ) AS profile_ids_unique
  FROM shaped
), validated AS (
  SELECT *,
    CASE WHEN has_config = 1
      AND metadata_valid = 1
      AND metadata_keys_unique = 1
      AND json_type(config_json, '$.version') = 'integer'
      AND json_extract(config_json, '$.version') = 1
      AND json_type(config_json, '$.enabled') IN ('true', 'false')
      AND (
        json_type(config_json, '$.maxInvocations') IS NULL
        OR (
          json_type(config_json, '$.maxInvocations') = 'integer'
          AND json_extract(config_json, '$.maxInvocations') >= 1
          AND json_extract(config_json, '$.maxInvocations') <= 9007199254740991
        )
      )
      AND (
        json_type(config_json, '$.maxToolCalls') IS NULL
        OR (
          json_type(config_json, '$.maxToolCalls') = 'integer'
          AND json_extract(config_json, '$.maxToolCalls') >= 1
          AND json_extract(config_json, '$.maxToolCalls') <= 9007199254740991
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(config_json) AS config_field
        GROUP BY config_field.key
        HAVING COUNT(*) > 1
      )
      AND json_type(config_json, '$.mainToolIds') = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(config_json) AS field
        WHERE field.key NOT IN (
          'version', 'enabled', 'maxInvocations', 'maxToolCalls',
          'mainToolIds', 'mainLoreScope', 'profiles'
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(main_tools_json) AS tool
        WHERE tool.type <> 'text'
          OR tool.value NOT IN (
            'lore_list_books', 'lore_get_book', 'lore_list_entries',
            'lore_get_entry', 'lore_search_entries', 'chat_search_history'
          )
      )
      AND NOT EXISTS (
        SELECT value FROM json_each(main_tools_json)
        GROUP BY value
        HAVING COUNT(*) > 1
      )
      AND json_type(config_json, '$.mainLoreScope') = 'text'
      AND json_extract(config_json, '$.mainLoreScope') IN ('active', 'all_owned')
      AND (
        json_extract(config_json, '$.mainLoreScope') <> 'all_owned'
        OR EXISTS (
          SELECT 1 FROM json_each(main_tools_json) AS tool
          WHERE tool.value IN (
            'lore_list_books', 'lore_get_book', 'lore_list_entries',
            'lore_get_entry', 'lore_search_entries'
          )
        )
      )
      AND json_type(config_json, '$.profiles') = 'array'
      AND json_array_length(profiles_json) <= 16
      AND profiles_valid
      AND profile_ids_unique
      THEN 1 ELSE 0 END AS structurally_valid
  FROM profile_validity
)
SELECT v.user_id, v.preset_id, v.has_config, v.config_json, v.profiles_json,
  v.main_tools_json, v.structurally_valid,
  CASE WHEN v.structurally_valid = 1 AND EXISTS (
    SELECT 1
    FROM json_each(v.profiles_json) AS profile
    LEFT JOIN connection_profiles AS cp
      ON cp.user_id = v.user_id
     AND cp.id = json_extract(profile.value, '$.connectionProfileId')
    WHERE json_type(profile.value, '$.connectionProfileId') = 'text'
      AND (
        cp.id IS NULL
        OR json_valid(cp.metadata) = 0
        OR json_extract(cp.metadata, '$.__lumiverse_import_review_required') = 1
        OR json_extract(cp.metadata, '$.__lumiverse_import_review_code') IS NOT NULL
      )
  ) THEN 1 ELSE 0 END AS foreign_binding
FROM validated AS v;

-- One normalized row exists for each owned preset, including presets without a
-- legacy config. Structural failures are inert and marked for repair; foreign
-- direct bindings are inert and marked for review.
INSERT OR IGNORE INTO preset_agent_configs (
  user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
  max_invocations, max_tool_calls, main_tool_ids, main_lore_scope, state,
  review_code, config_revision, created_at, updated_at
)
SELECT
  p.user_id,
  p.id,
  2,
  CASE WHEN v.structurally_valid = 1
        AND json_extract(v.config_json, '$.enabled') = 1
        AND v.foreign_binding = 0
       THEN 1 ELSE 0 END,
  '["response"]',
  'response',
  CASE WHEN json_type(v.config_json, '$.maxInvocations') = 'integer'
        AND json_extract(v.config_json, '$.maxInvocations') BETWEEN 1 AND 9007199254740991
       THEN json_extract(v.config_json, '$.maxInvocations') ELSE 64 END,
  CASE WHEN json_type(v.config_json, '$.maxToolCalls') = 'integer'
        AND json_extract(v.config_json, '$.maxToolCalls') BETWEEN 1 AND 9007199254740991
       THEN json_extract(v.config_json, '$.maxToolCalls') ELSE 64 END,
  CASE WHEN v.structurally_valid = 1 THEN v.main_tools_json ELSE '[]' END,
  CASE WHEN v.structurally_valid = 1
        AND json_extract(v.config_json, '$.mainLoreScope') IN ('active', 'all_owned')
       THEN json_extract(v.config_json, '$.mainLoreScope') ELSE 'active' END,
  CASE
    WHEN v.has_config = 0 THEN 'ready'
    WHEN v.structurally_valid = 0 THEN 'repair_required'
    WHEN v.foreign_binding = 1 THEN 'review_required'
    ELSE 'ready'
  END,
  CASE
    WHEN v.structurally_valid = 0 AND v.has_config = 1 THEN 'invalid_legacy_config'
    WHEN v.foreign_binding = 1 THEN 'foreign_connection'
    ELSE NULL
  END,
  1,
  COALESCE(p.created_at, unixepoch()),
  COALESCE(p.updated_at, unixepoch())
FROM presets AS p
JOIN _agent_config_v1_validation AS v
  ON v.user_id = p.user_id AND v.preset_id = p.id
WHERE p.user_id IS NOT NULL;

-- Legacy direct profile references become deterministic authored slots. Local
-- ownership is retained only in the separate binding table.
INSERT OR IGNORE INTO preset_agent_connection_slots (user_id, preset_id, slot_id, label, required_capabilities)
SELECT
  p.user_id,
  p.id,
  'profile/' || json_extract(profile.value, '$.id'),
  COALESCE(json_extract(profile.value, '$.name'), json_extract(profile.value, '$.id')),
  '["generation"]'
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(CASE WHEN json_type(v.config_json, '$.profiles') = 'array'
                   THEN v.profiles_json ELSE '[]' END) AS profile
WHERE v.structurally_valid = 1
  AND c.state IN ('ready', 'review_required')
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.connectionProfileId') IS NOT NULL;

INSERT OR IGNORE INTO preset_agent_profiles (
  user_id, preset_id, profile_id, name, system_prompt, connection_ref_kind, slot_id,
  tool_ids, lore_scope, allow_main_delegation, failure_policy, stream_activity,
  max_output_tokens, timeout_ms
)
SELECT
  p.user_id,
  p.id,
  json_extract(profile.value, '$.id'),
  COALESCE(json_extract(profile.value, '$.name'), json_extract(profile.value, '$.id')),
  COALESCE(json_extract(profile.value, '$.systemPrompt'), ''),
  CASE WHEN json_extract(profile.value, '$.connectionProfileId') IS NULL THEN 'inherit_main' ELSE 'slot' END,
  CASE WHEN json_extract(profile.value, '$.connectionProfileId') IS NULL THEN NULL ELSE 'profile/' || json_extract(profile.value, '$.id') END,
  CASE WHEN json_type(json_extract(profile.value, '$.toolIds')) = 'array' THEN json_extract(profile.value, '$.toolIds') ELSE '[]' END,
  CASE WHEN json_extract(profile.value, '$.loreScope') IN ('active', 'all_owned') THEN json_extract(profile.value, '$.loreScope') ELSE 'active' END,
  CASE WHEN json_extract(profile.value, '$.allowMainDelegation') = 1 THEN 1 ELSE 0 END,
  CASE WHEN json_extract(profile.value, '$.failurePolicy') = 'required' THEN 'required' ELSE 'optional' END,
  CASE WHEN json_extract(profile.value, '$.streamActivity') = 1 THEN 1 ELSE 0 END,
  CASE WHEN json_type(json_extract(profile.value, '$.maxOutputTokens')) = 'integer'
         AND json_extract(profile.value, '$.maxOutputTokens') BETWEEN 64 AND 8192
       THEN json_extract(profile.value, '$.maxOutputTokens') ELSE 64 END,
  CASE WHEN json_type(json_extract(profile.value, '$.timeoutMs')) = 'integer'
         AND json_extract(profile.value, '$.timeoutMs') >= 5000
         AND json_extract(profile.value, '$.timeoutMs') % 1000 = 0
       THEN json_extract(profile.value, '$.timeoutMs') ELSE 5000 END
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(v.profiles_json) AS profile
WHERE v.structurally_valid = 1
  AND c.state IN ('ready', 'review_required')
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.id') GLOB '[a-z]*';

INSERT OR IGNORE INTO preset_agent_slot_bindings (
  user_id, preset_id, slot_id, connection_id, binding_revision, state, review_code
)
SELECT
  p.user_id,
  p.id,
  'profile/' || json_extract(profile.value, '$.id'),
  cp.id,
  1,
  'ready',
  NULL
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(v.profiles_json) AS profile
JOIN connection_profiles AS cp
  ON cp.id = json_extract(profile.value, '$.connectionProfileId')
 AND cp.user_id = p.user_id
 AND json_valid(cp.metadata) = 1
 AND COALESCE(json_extract(cp.metadata, '$.__lumiverse_import_review_required'), 0) <> 1
 AND json_extract(cp.metadata, '$.__lumiverse_import_review_code') IS NULL
WHERE v.structurally_valid = 1
  AND c.state IN ('ready', 'review_required')
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.connectionProfileId') IS NOT NULL;

INSERT OR IGNORE INTO preset_agent_slot_bindings (
  user_id, preset_id, slot_id, connection_id, binding_revision, state, review_code
)
SELECT
  p.user_id,
  p.id,
  'profile/' || json_extract(profile.value, '$.id'),
  NULL,
  1,
  'review_required',
  'foreign_connection'
FROM presets AS p
JOIN preset_agent_configs AS c ON c.user_id = p.user_id AND c.preset_id = p.id
JOIN _agent_config_v1_validation AS v ON v.user_id = p.user_id AND v.preset_id = p.id
JOIN json_each(v.profiles_json) AS profile
LEFT JOIN connection_profiles AS cp
  ON cp.id = json_extract(profile.value, '$.connectionProfileId')
 AND cp.user_id = p.user_id
WHERE v.structurally_valid = 1
  AND c.state = 'review_required'
  AND json_type(profile.value, '$.id') = 'text'
  AND json_extract(profile.value, '$.connectionProfileId') IS NOT NULL
  AND (
    cp.id IS NULL
    OR json_valid(cp.metadata) = 0
    OR json_extract(cp.metadata, '$.__lumiverse_import_review_required') = 1
    OR json_extract(cp.metadata, '$.__lumiverse_import_review_code') IS NOT NULL
  );

-- Reserved metadata is import-only. Keep ordinary Loom metadata but remove every
-- executable V1 config marker after the normalized row has been populated.
UPDATE presets
SET metadata = json_remove(metadata, '$.agentConfig', '$.agentConfigReviewRequired', '$.agentConfigReview')
WHERE json_valid(metadata)
  AND (json_type(metadata, '$.agentConfig') IS NOT NULL
    OR json_type(metadata, '$.agentConfigReviewRequired') IS NOT NULL
    OR json_type(metadata, '$.agentConfigReview') IS NOT NULL);

DROP TABLE _agent_config_v1_validation;
CREATE INDEX IF NOT EXISTS idx_preset_agent_configs_user_state
  ON preset_agent_configs(user_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_preset_agent_profiles_preset
  ON preset_agent_profiles(user_id, preset_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_preset_agent_slots_preset
  ON preset_agent_connection_slots(user_id, preset_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_preset_agent_bindings_connection
  ON preset_agent_slot_bindings(user_id, connection_id);
CREATE INDEX IF NOT EXISTS idx_chat_agent_mode_overrides_user
  ON chat_agent_mode_overrides(user_id, updated_at DESC);
