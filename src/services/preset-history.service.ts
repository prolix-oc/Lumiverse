import { getDb } from "../db/connection";
import type { MacroEnv } from "../macros/types";
import { MAX_PRESET_HISTORY, presetHistoryDependency, readPresetHistoryEntry, type PresetHistorySnapshot } from "../types/preset-history";

// Match String.trim() eligibility without fetching message bodies into JS.
const TRIM_CHARACTERS = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** A lightweight projection for display/chunk callers which intentionally do not load chat bodies. */
function loadCandidates(userId: string, chatId: string) {
  const candidates = [];
  const rows = getDb().query(`SELECT m.swipe_id,
    length(trim(m.content, ?)) > 0 AS has_content,
    json_extract(m.extra, '$.hidden') AS hidden,
    json_extract(m.extra, '$._loom_inject') AS injected,
    json_extract(m.extra, '$.greeting') AS greeting,
    json_extract(m.extra, '$.spindle_role') AS role,
    json_extract(m.extra, '$.spindle_metadata.preset_contexts[' || m.swipe_id || ']') AS preset_context,
    CASE WHEN json_type(m.extra, '$.generationMetricsBySwipe') = 'array'
      THEN json_extract(m.extra, '$.generationMetricsBySwipe[' || m.swipe_id || ']')
      ELSE json_extract(m.extra, '$.generationMetrics') END AS metrics,
    CASE WHEN json_type(m.extra, '$.promptActivationBySwipe') = 'array'
      THEN json_extract(m.extra, '$.promptActivationBySwipe[' || m.swipe_id || ']')
      ELSE json_extract(m.extra, '$.promptActivation') END AS activation
    FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE m.chat_id = ? AND c.user_id = ? AND m.is_user = 0 AND m.swipe_id >= 0
    ORDER BY m.index_in_chat DESC`).iterate(TRIM_CHARACTERS, chatId, userId) as Iterable<{
      swipe_id: number; has_content: number; hidden: unknown; injected: unknown; greeting: unknown;
      role: unknown; preset_context: string | null; metrics: string | null; activation: string | null;
    }>;
  const parse = (value: unknown) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return undefined; }
  };
  for (const row of rows) {
    if (!Number.isSafeInteger(row.swipe_id)) continue;
    const entry = readPresetHistoryEntry({ is_user: false, content: row.has_content ? "1" : "", swipe_id: 0,
      extra: { hidden: row.hidden, _loom_inject: row.injected, greeting: row.greeting, spindle_role: row.role,
        spindle_metadata: { preset_contexts: [parse(row.preset_context)] },
        generationMetrics: parse(row.metrics), promptActivation: parse(row.activation) } });
    if (entry) candidates.push(entry);
    if (candidates.length === MAX_PRESET_HISTORY) break;
  }
  return candidates;
}

/** Hydrates once per environment snapshot, including empty/negative results. No durable writes. */
export function resolvePresetHistory(env: MacroEnv): string[] {
  const snapshot: PresetHistorySnapshot = env.extra.presetHistory ??= {};
  if (snapshot.names) return snapshot.names;
  const owner = typeof env.extra.userId === "string" ? env.extra.userId : undefined;
  const candidates = snapshot.candidates ??= owner && env.chat.id ? loadCandidates(owner, env.chat.id) : [];
  const ids = [...new Set(candidates.filter(entry => !entry.name && entry.id).map(entry => entry.id!))];
  const names = new Map<string, string>();
  if (owner && ids.length) {
    for (const row of getDb().query(`SELECT id, name FROM presets WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .all(owner, ...ids) as { id: string; name: string }[]) {
      if (typeof row.name === "string" && row.name.trim()) names.set(row.id, row.name);
    }
  }
  return snapshot.names = candidates.flatMap(entry => {
    const name = entry.name ?? (entry.id ? names.get(entry.id) : undefined);
    return name ? [name] : [];
  });
}

/** Exact result token; independent of inactive swipes, timings, or message body bytes. */
export function presetHistoryDependencyValue(env: MacroEnv, dependency: string): string | undefined {
  return dependency === presetHistoryDependency(env.chat.id) ? JSON.stringify(resolvePresetHistory(env)) : undefined;
}
