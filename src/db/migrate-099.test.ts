import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION_099 = "099_character_library_scope.sql";
const MIGRATION_099_SQL = `ALTER TABLE characters ADD COLUMN library_scope TEXT NOT NULL DEFAULT 'mine' CHECK(library_scope IN ('mine', 'shared'));

CREATE INDEX idx_characters_user_library_scope
  ON characters(user_id, library_scope);

CREATE INDEX idx_characters_user_library_scope_updated
  ON characters(user_id, library_scope, updated_at DESC);
`;
const INDEX_SCOPE = "idx_characters_user_library_scope";
const INDEX_SCOPE_UPDATED = "idx_characters_user_library_scope_updated";

type CharacterColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
};

type IndexColumn = {
  seqno: number;
  name: string | null;
  desc: number;
  key: number;
};

function libraryScopeColumn(db: Database): CharacterColumn | null {
  const columns = db.query("PRAGMA table_info('characters')").all() as CharacterColumn[];
  const column = columns.find((candidate) => candidate.name === "library_scope");
  return column
    ? {
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
      }
    : null;
}

function indexColumns(db: Database, indexName: string): Array<Pick<IndexColumn, "seqno" | "name" | "desc">> {
  const columns = db.query(`PRAGMA index_xinfo('${indexName}')`).all() as IndexColumn[];
  return columns
    .filter((column) => column.key === 1)
    .map(({ seqno, name, desc }) => ({ seqno, name, desc }));
}

describe("099 character library scope", () => {
  test("keeps the canonical migration identity and body", async () => {
    expect(MIGRATION_099).toBe("099_character_library_scope.sql");
    const sql = await Bun.file(join(import.meta.dir, "migrations", MIGRATION_099)).text();
    expect(sql.replaceAll("\r\n", "\n")).toBe(MIGRATION_099_SQL);
  });

  test("is recorded as already applied after a fresh baseline bootstrap", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db);

      expect(
        (db.query("PRAGMA table_info('characters')").all() as Array<{ name: string }>).some(
          (column) => column.name === "library_scope",
        ),
      ).toBe(true);
      expect(
        db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION_099),
      ).toEqual({ count: 1 });

      db.run("INSERT INTO characters (id, name) VALUES ('existing', 'Existing')");

      expect(db.query("SELECT library_scope FROM characters WHERE id = 'existing'").get()).toEqual({
        library_scope: "mine",
      });
      expect(libraryScopeColumn(db)).toEqual({
        name: "library_scope",
        type: "TEXT",
        notnull: 1,
        dflt_value: "'mine'",
      });

      const indexNames = (db.query("PRAGMA index_list('characters')").all() as Array<{ name: string }>).map(
        (index) => index.name,
      );
      expect(indexNames).toEqual(expect.arrayContaining([INDEX_SCOPE, INDEX_SCOPE_UPDATED]));
      expect(indexColumns(db, INDEX_SCOPE)).toEqual([
        { seqno: 0, name: "user_id", desc: 0 },
        { seqno: 1, name: "library_scope", desc: 0 },
      ]);
      expect(indexColumns(db, INDEX_SCOPE_UPDATED)).toEqual([
        { seqno: 0, name: "user_id", desc: 0 },
        { seqno: 1, name: "library_scope", desc: 0 },
        { seqno: 2, name: "updated_at", desc: 1 },
      ]);

      db.run(
        "INSERT INTO characters (id, name, library_scope) VALUES ('shared', 'Shared', 'shared')",
      );
      expect(db.query("SELECT library_scope FROM characters WHERE id = 'shared'").get()).toEqual({
        library_scope: "shared",
      });
      expect(() =>
        db.run("INSERT INTO characters (id, name, library_scope) VALUES ('invalid', 'Invalid', 'invalid')"),
      ).toThrow();

      await runMigrations(db);
      expect(
        db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION_099),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
