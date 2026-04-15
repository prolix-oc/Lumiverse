import { getDb } from "../db/connection";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../types/pagination";

const MAX_STMT_CACHE = 200;
const stmtCache = new Map<string, ReturnType<ReturnType<typeof getDb>["query"]>>();

function cachedQuery(sql: string) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    // Evict the oldest entry when the cache is full to prevent unbounded growth
    // if any caller ever introduces dynamic SQL strings.
    if (stmtCache.size >= MAX_STMT_CACHE) {
      const firstKey = stmtCache.keys().next().value;
      if (firstKey !== undefined) stmtCache.delete(firstKey);
    }
    stmt = getDb().query(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

export function clearStmtCache(): void {
  stmtCache.clear();
}

export function parsePagination(
  rawLimit?: string,
  rawOffset?: string,
  defaultLimit: number = DEFAULT_LIMIT
): PaginationParams {
  let limit = defaultLimit;
  if (rawLimit !== undefined) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed)) limit = Math.min(Math.max(parsed, 1), MAX_LIMIT);
  }

  let offset = 0;
  if (rawOffset !== undefined) {
    const parsed = parseInt(rawOffset, 10);
    if (!isNaN(parsed) && parsed >= 0) offset = parsed;
  }

  return { limit, offset };
}

export function paginatedQuery<TRow, TEntity>(
  dataSql: string,
  countSql: string,
  params: any[],
  pagination: PaginationParams,
  rowMapper: (row: TRow) => TEntity
): PaginatedResult<TEntity> {
  // Fetch one extra row to detect if there are more results (avoids COUNT query when possible)
  const rows = cachedQuery(`${dataSql} LIMIT ? OFFSET ?`)
    .all(...params, pagination.limit + 1, pagination.offset) as TRow[];

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.length = pagination.limit; // trim the extra probe row

  // Only run the COUNT query if we actually need the exact total
  // (i.e., we're not on page 1 fetching everything, or there are more pages)
  let total: number;
  if (pagination.offset === 0 && !hasMore) {
    // First page and all results fit — total is just the row count
    total = rows.length;
  } else {
    const countRow = cachedQuery(countSql).get(...params) as { count: number } | null;
    total = countRow?.count ?? 0;
  }

  return {
    data: rows.map(rowMapper),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}
