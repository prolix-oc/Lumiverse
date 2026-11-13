-- Multiplayer rooms. A "room" IS the host's existing chat: the host instance
-- runs all generation, characters and presets, while peers are remote humans
-- who contribute messages + personas and receive streamed bot replies.
--
-- These side tables hold room / participant / turn / ban state next to the
-- chat. The hot `messages` table is deliberately left untouched — peer author
-- attribution rides in `messages.extra` JSON (mirroring the existing
-- `extra.persona_id` convention), so this migration adds no columns there.

CREATE TABLE multiplayer_rooms (
  id                          TEXT PRIMARY KEY,
  chat_id                     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  host_user_id                TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status                      TEXT NOT NULL DEFAULT 'open',          -- 'open' | 'locked' | 'closed'
  turn_strategy               TEXT NOT NULL DEFAULT 'round_robin',   -- 'round_robin' | 'freeform'
  freeform_deadline           INTEGER,                                -- unixepoch sec; null unless a freeform window is open
  turn_order                  TEXT NOT NULL DEFAULT '[]',            -- JSON array of participant ids (host-managed sequence)
  current_turn_participant_id TEXT,                                   -- round_robin: whose turn (always = turn_order[turn_index])
  turn_index                  INTEGER NOT NULL DEFAULT 0,
  round_counter               INTEGER NOT NULL DEFAULT 0,
  settings                    TEXT NOT NULL DEFAULT '{}',            -- JSON: maxPeers (<=8), freeformWindowSec, ...
  created_at                  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at                  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_mp_rooms_chat ON multiplayer_rooms(chat_id);
CREATE INDEX idx_mp_rooms_host ON multiplayer_rooms(host_user_id);

CREATE TABLE multiplayer_participants (
  id               TEXT PRIMARY KEY,                                  -- participant id; also the author key stamped on messages.extra.mp
  room_id          TEXT NOT NULL REFERENCES multiplayer_rooms(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'peer',                      -- 'host' | 'peer'
  identity_kind    TEXT NOT NULL,                                     -- 'user' | 'token'
  identity_ref     TEXT NOT NULL,                                     -- user_id (local account) OR token subject (remote peer)
  display_name     TEXT NOT NULL DEFAULT '',                          -- peer-supplied, validated, UNTRUSTED
  persona_snapshot TEXT NOT NULL DEFAULT '{}',                        -- JSON frozen copy {name, description, pronouns?, avatarUrl?}
  status           TEXT NOT NULL DEFAULT 'active',                    -- 'active' | 'left' | 'kicked'
  joined_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen        INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One participant row per stable identity per room, so a reconnecting peer
-- re-attaches to the same row (idempotent join, same turn slot).
CREATE UNIQUE INDEX idx_mp_participants_identity
  ON multiplayer_participants(room_id, identity_kind, identity_ref);
CREATE INDEX idx_mp_participants_room ON multiplayer_participants(room_id, status);

CREATE TABLE multiplayer_bans (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES multiplayer_rooms(id) ON DELETE CASCADE,
  identity_kind TEXT NOT NULL,                                        -- mirrors participants
  identity_ref  TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  banned_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_mp_bans_identity
  ON multiplayer_bans(room_id, identity_kind, identity_ref);
