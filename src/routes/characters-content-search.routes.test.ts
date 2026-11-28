import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { listCharacterSummaries } from "../services/characters.service";
import { charactersRoutes } from "./characters.routes";

const baseline = readFileSync(new URL("../db/baseline.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../db/migrations/137_character_content_search.sql", import.meta.url), "utf8");
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
app.route("/characters", charactersRoutes);

function initialize(sql = baseline) {
  closeDatabase(); initDatabase(":memory:"); getDb().run(sql);
  getDb().run(`INSERT INTO user(id,name,email) VALUES('owner','Owner','owner@example.invalid'),('other','Other','other@example.invalid')`);
}
function card(id: string, fields: Record<string, string | number> = {}) {
  const values = { id, user_id: "owner", name: id, created_at: 1, updated_at: 1, ...fields };
  const keys = Object.keys(values);
  getDb().query(`INSERT INTO characters(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...Object.values(values));
}
function find(search: string, options: Parameters<typeof listCharacterSummaries>[2] = {}) {
  return listCharacterSummaries("owner", { limit: 80, offset: 0 }, { search, searchIn: "all", sort: "name", ...options });
}
function integrity() {
  getDb().run("INSERT INTO characters_content_fts(characters_content_fts,rank) VALUES('integrity-check',1)");
  getDb().run("INSERT INTO characters_fts(characters_fts,rank) VALUES('integrity-check',1)");
}
beforeEach(() => initialize());
afterEach(() => closeDatabase());

describe("character content search", () => {
  test("indexes every supported field and alternate text while preserving metadata search", () => {
    const fields = ["name", "creator", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions"];
    for (const field of fields) card(field, { [field]: `${field}uniqueneedle` });
    card("tags", { tags: '["uniqueneedletag"]' });
    card("alternates", {
      alternate_greetings: '["uniqueneedlegreeting","魔法図書館"]',
      extensions: JSON.stringify({ alternate_fields: { description: [{ label: "uniqueneedlelabel", content: "uniqueneedlevariant" }] }, private_extension: "notindexedsecret" }),
    });
    for (const field of fields) expect(find(`${field}uniqueneedle`).data.map(c => c.id)).toEqual([field]);
    for (const term of ["uniqueneedlegreeting", "uniqueneedlelabel", "uniqueneedlevariant", "魔法図書館"]) expect(find(term).data.map(c => c.id)).toEqual(["alternates"]);
    expect(find("uniqueneedletag").total).toBe(1);
    expect(find("notindexedsecret").total).toBe(0);
    expect(find("descriptionuniqueneedle", { searchIn: "metadata" }).total).toBe(0);
    expect(find("creatoruniqueneedle", { searchIn: "metadata" }).total).toBe(1);
    expect(find("alternates uniqueneedlevariant").total).toBe(1);
    integrity();
  });

  test("updates derived text and removes stale matches on edit and deletion", () => {
    card("editable", { description: "oldbodyneedle", alternate_greetings: '["oldgreetingneedle"]', extensions: '{"alternate_fields":{"scenario":[{"content":"oldvariantneedle"}]}}' });
    getDb().run(`UPDATE characters SET description='newbodyneedle',alternate_greetings='["newgreetingneedle"]',extensions='{"alternate_fields":{"personality":[{"content":"newvariantneedle"}]}}' WHERE id='editable'`);
    for (const term of ["oldbodyneedle", "oldgreetingneedle", "oldvariantneedle"]) expect(find(term).total).toBe(0);
    for (const term of ["newbodyneedle", "newgreetingneedle", "newvariantneedle"]) expect(find(term).total).toBe(1);
    integrity();
    getDb().run("DELETE FROM characters WHERE id='editable'");
    expect(find("newbodyneedle").total).toBe(0);
    expect(getDb().query("SELECT COUNT(*) AS n FROM character_search_text").get()).toEqual({ n: 0 });
    integrity();
  });

  test("leaves the index unchanged for unrelated changes and unchanged body saves", () => {
    card("stable", { description: "stableneedle" });
    const snapshot = () => ["data", "idx", "docsize", "config"].map(suffix =>
      getDb().query(`SELECT * FROM characters_content_fts_${suffix}`).all());
    const before = snapshot();
    for (const sql of [
      "UPDATE characters SET folder='Folder',updated_at=2 WHERE id='stable'",
      "UPDATE characters SET description=description WHERE id='stable'",
      "UPDATE characters SET extensions='{\"theme\":\"blue\"}' WHERE id='stable'",
    ]) {
      getDb().run(sql); expect(snapshot()).toEqual(before);
    }
    expect(find("stableneedle").total).toBe(1); integrity();
  });

  test("backfills legacy cards transactionally, including irregular alternate data", () => {
    initialize(baseline.slice(0, baseline.indexOf("-- Full-content search keeps")));
    card("legacy", { first_mes: "legacygreetingneedle", extensions: JSON.stringify({ alternate_fields: { description: [null, "ignored", { content: "legacyvariantneedle" }], personality: "ignored" } }) });
    getDb().transaction(() => getDb().run(migration))();
    expect(find("legacygreetingneedle").total).toBe(1);
    expect(find("legacyvariantneedle").total).toBe(1);
    expect(find("ignored").total).toBe(0); integrity();
  });

  test("finds text at the end of large cards without truncating fields", () => {
    const large = "A quiet harbor at sunset. ".repeat(2500);
    card("long", { description: large + " taildescriptionneedle", alternate_greetings: JSON.stringify([large + " tailgreetingneedle"]) });
    expect(find("taildescriptionneedle").total).toBe(1);
    expect(find("tailgreetingneedle").total).toBe(1);
    getDb().run("UPDATE characters SET creator_notes=? WHERE id='long'", [large + " tailnotesneedle"]);
    expect(find("tailnotesneedle").total).toBe(1); integrity();
  });

  test("preserves ownership, deletion, scope, tags, favorites, pagination and every sort", () => {
    card("Alpha", { description: "filterneedle", tags: '["keep"]', library_scope: "mine" });
    card("Bravo", { description: "filterneedle", tags: '["keep"]', library_scope: "mine" });
    card("Shared", { description: "filterneedle", tags: '["keep"]', library_scope: "shared" });
    card("Foreign", { description: "filterneedle", user_id: "other" });
    card("Deleting", { description: "filterneedle", deleting: 1 });
    card("Hidden", { description: "filterneedle", extensions: '{"_lumiverse_library_hidden":true}' });
    for (const sort of [undefined, "name", "created", "recent", "most_chats", "discover"]) {
      const result = listCharacterSummaries("owner", { limit: 1, offset: 1 }, { search: "filterneedle", searchIn: "all", tags: ["keep"], scope: "mine", sort });
      expect(result.total).toBe(2); expect(result.data).toHaveLength(1);
      expect(["Alpha", "Bravo"]).toContain(result.data[0].id);
    }
    expect(find("filterneedle", { filterMode: "favorites", favoriteIds: ["Bravo", "Foreign"] }).data.map(c => c.id)).toEqual(["Bravo"]);
    expect(find("filterneedle", { excludeTags: ["keep"], includeSystem: false }).total).toBe(0);
    getDb().run("INSERT INTO chats(id,user_id,character_id,name) VALUES('chat','owner','Alpha','Chat')");
    expect(find("filterneedle", { chatId: "chat" }).data.map(c => c.id)).toEqual(["Alpha"]);
  });

  test("validates HTTP scope and short/mixed terms while treating FTS syntax literally", async () => {
    card("http", { first_mes: 'quoted "hello" AND greetings' });
    const request = (query: string) => app.request("http://localhost/characters/summary?" + query);
    const result = await request("search_in=all&search=greetings&sort=name");
    expect(result.status).toBe(200); expect((await result.json()).total).toBe(1);
    expect((await (await request("search=greetings")).json()).total).toBe(0);
    for (const query of ["search_in=invalid", "search_in=all&search=hi", "search_in=all&search=hello%20to", "search_in=all&search=魔法", "search_in=all&search=😀"]) expect((await request(query)).status).toBe(400);
    expect((await request("search_in=all")).status).toBe(200);
    expect((await request("search_in=all&search=%22hello%22")).status).toBe(200);
    expect((await request("search=hi")).status).toBe(200);
  });
});
