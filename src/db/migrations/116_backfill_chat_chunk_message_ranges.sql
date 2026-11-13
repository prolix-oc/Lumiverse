-- chat_chunks.created_at has one-second precision and represents row creation,
-- not conversation position. Backfill the existing positional columns from the
-- canonical messages referenced by each chunk.

UPDATE chat_chunks
SET message_range_start = (
      SELECT MIN(m.index_in_chat)
      FROM json_each(
        CASE WHEN json_valid(chat_chunks.message_ids)
          THEN chat_chunks.message_ids
          ELSE '[]'
        END
      ) AS chunk_message
      JOIN messages AS m
        ON m.id = chunk_message.value
       AND m.chat_id = chat_chunks.chat_id
    ),
    message_range_end = (
      SELECT MAX(m.index_in_chat)
      FROM json_each(
        CASE WHEN json_valid(chat_chunks.message_ids)
          THEN chat_chunks.message_ids
          ELSE '[]'
        END
      ) AS chunk_message
      JOIN messages AS m
        ON m.id = chunk_message.value
       AND m.chat_id = chat_chunks.chat_id
    )
WHERE message_range_start IS NULL
   OR message_range_end IS NULL;
