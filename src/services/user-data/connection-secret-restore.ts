import { getDb } from "../../db/connection";

interface ConnectionSecretTarget {
  table: "connection_profiles" | "image_gen_connections" | "tts_connections" | "stt_connections";
  id: string;
}

const CONNECTION_SECRET_TARGETS: ReadonlyArray<{
  pattern: RegExp;
  table: ConnectionSecretTarget["table"];
}> = [
  { pattern: /^connection_(.+)_api_key$/, table: "connection_profiles" },
  { pattern: /^image_gen_connection_(.+)_api_key$/, table: "image_gen_connections" },
  { pattern: /^tts_connection_(.+)_api_key$/, table: "tts_connections" },
  { pattern: /^stt_connection_(.+)_api_key$/, table: "stt_connections" },
];

export function connectionTargetForSecret(key: string): ConnectionSecretTarget | null {
  for (const target of CONNECTION_SECRET_TARGETS) {
    const match = target.pattern.exec(key);
    if (match) return { table: target.table, id: match[1] };
  }
  return null;
}

/**
 * Imported connection rows are deliberately scrubbed to `has_api_key = 0`
 * before their encrypted credentials are restored. Reconcile that denormalized
 * flag after a credential has been written so settings UIs and provider checks
 * see the restored key.
 */
export function markConnectionSecretRestored(userId: string, key: string): boolean {
  const target = connectionTargetForSecret(key);
  if (!target) return false;

  const result = getDb()
    .query(`UPDATE ${target.table} SET has_api_key = 1 WHERE id = ? AND user_id = ?`)
    .run(target.id, userId);
  return result.changes > 0;
}
