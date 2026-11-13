-- Prompt breakdowns contain the full outbound prompt, including chat history.
-- Before deletion-time invalidation was added, deleting a message could leave
-- both its direct breakdown and later snapshots containing its content behind.
--
-- Message indexes are append-only and are not renumbered after deletion. For
-- this one-time cleanup, ROW_NUMBER identifies the first historical gap and
-- invalidates breakdowns from that point forward. This deliberately lives in a
-- migration instead of recurring VACUUM maintenance: the gap remains after the
-- deletion, and future snapshots created after that deletion are valid.

WITH ordered_messages AS (
  SELECT
    m.id,
    m.chat_id,
    c.user_id,
    m.index_in_chat,
    ROW_NUMBER() OVER (
      PARTITION BY m.chat_id
      ORDER BY m.index_in_chat, m.id
    ) - 1 AS expected_index
  FROM messages m
  JOIN chats c ON c.id = m.chat_id
  WHERE m.chat_id IN (SELECT DISTINCT chat_id FROM message_breakdowns)
)
DELETE FROM message_breakdowns
WHERE NOT EXISTS (
  SELECT 1
  FROM ordered_messages m
  WHERE m.id = message_breakdowns.message_id
    AND m.chat_id = message_breakdowns.chat_id
    AND m.user_id = message_breakdowns.user_id
    AND m.index_in_chat = m.expected_index
);
