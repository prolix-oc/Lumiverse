import { getDb } from "../db/connection";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../types/pagination";

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
  const db = getDb();

  const countRow = db.query(countSql).get(...params) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const rows = db
    .query(`${dataSql} LIMIT ? OFFSET ?`)
    .all(...params, pagination.limit, pagination.offset) as TRow[];

  return {
    data: rows.map(rowMapper),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}
