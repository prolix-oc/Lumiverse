import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const MIGRATION_PATH = `${import.meta.dir}/migrations/121_retire_lumi_spot_links.sql`;

describe("121 retire hosted LumiHub links", () => {
  test("deletes lumi.spot links while preserving custom hubs and lookalike hosts", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE lumihub_link (
          id TEXT PRIMARY KEY,
          lumihub_url TEXT NOT NULL
        );
        INSERT INTO lumihub_link VALUES
          ('hosted', 'https://lumi.spot'),
          ('hosted-trailing', 'HTTPS://LUMI.SPOT/'),
          ('hosted-www', 'https://www.lumi.spot'),
          ('hosted-path', 'https://lumi.spot/api'),
          ('hosted-port', 'https://lumi.spot:443'),
          ('custom', 'https://hub.example.com'),
          ('lookalike', 'https://lumi.spot.evil.example'),
          ('userinfo', 'https://lumi.spot@evil.example');
      `);

      db.run(await Bun.file(MIGRATION_PATH).text());

      expect(db.query("SELECT id FROM lumihub_link ORDER BY id").all()).toEqual([
        { id: "custom" },
        { id: "lookalike" },
        { id: "userinfo" },
      ]);
    } finally {
      db.close();
    }
  });
});
