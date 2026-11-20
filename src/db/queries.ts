import type { SQLQueryBindings } from "bun:sqlite";
import { executeDatabaseOperation, type DatabaseExecutionOptions } from "./execution";
import type { SqlStatementOperation } from "./execution-protocol";

/** Runtime queries always use the supervised executor for file databases. */
export function readDatabaseRow<T>(sql: string, bindings: SQLQueryBindings[] = [], options?: DatabaseExecutionOptions): Promise<T | null> {
  return executeDatabaseOperation<T | null>({ kind: "read", statement: { sql, bindings, mode: "get" } }, options);
}

export function readDatabaseRows<T>(sql: string, bindings: SQLQueryBindings[] = [], options?: DatabaseExecutionOptions): Promise<T[]> {
  return executeDatabaseOperation<T[]>({ kind: "read", statement: { sql, bindings, mode: "all" } }, options);
}

export function runDatabaseStatements<T extends unknown[]>(statements: SqlStatementOperation[], options?: DatabaseExecutionOptions): Promise<T> {
  return executeDatabaseOperation<T>({ kind: "transaction", statements }, options);
}

export async function runDatabaseStatement(sql: string, bindings: SQLQueryBindings[] = [], options?: DatabaseExecutionOptions): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
  const [result] = await runDatabaseStatements<[{ changes: number; lastInsertRowid: number | bigint }]>([{ sql, bindings }], options);
  return result;
}
