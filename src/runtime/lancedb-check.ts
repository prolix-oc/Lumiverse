import assert from "node:assert/strict";
import { connect, Index } from "@lancedb/lancedb";

/** Exercise the actual native engine and its persisted vector/full-text indexes. */
export async function checkLanceDb(directory: string): Promise<void> {
  const query = [1, 0, 0, 0, 0, 0, 0, 0];
  const rows = Array.from({ length: 256 }, (_, i) => ({
    id: `row-${i}`,
    vector: [Math.cos(i * Math.PI * 2 / 256), Math.sin(i * Math.PI * 2 / 256), 0, 0, 0, 0, 0, 0],
    content: i === 0 ? "lumiverse native engine" : `other vector ${i}`,
  }));
  const connection = await connect(directory);
  try {
    const table = await connection.createTable("check", rows);
    assert.equal(await table.countRows(), rows.length);
    assert.equal((await table.vectorSearch(query).distanceType("cosine").limit(1).toArray())[0]?.id, "row-0");
    await table.createIndex("vector", { config: Index.ivfFlat({ numPartitions: 2, distanceType: "cosine" }) });
    await table.createIndex("content", { config: Index.fts() });
    await table.createIndex("id", { config: Index.btree() });
    assert.equal((await table.vectorSearch(query).distanceType("cosine").nprobes(2).limit(1).toArray())[0]?.id, "row-0");
    assert.equal((await table.search("lumiverse", "fts").limit(1).toArray())[0]?.id, "row-0");
    await table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([
      { ...rows[0]!, content: "lumiverse updated native engine" },
      { id: "added", vector: [0, 1, 0, 0, 0, 0, 0, 0], content: "persisted addition" },
      { id: "deleted", vector: [0, 1, 0, 0, 0, 0, 0, 0], content: "temporary addition" },
    ]);
    await table.delete("id = 'deleted'");
    assert.equal(await table.countRows(), rows.length + 1);
    assert.equal((await table.query().where("id = 'row-0'").select(["content"]).toArray())[0]?.content, "lumiverse updated native engine");
  } finally { connection.close(); }
  const reopened = await connect(directory);
  try {
    const table = await reopened.openTable("check");
    assert.equal(await table.countRows(), rows.length + 1);
    assert.equal((await table.vectorSearch(query).distanceType("cosine").nprobes(2).limit(1).toArray())[0]?.id, "row-0");
    assert.equal((await table.search("lumiverse", "fts").limit(1).toArray())[0]?.id, "row-0");
    assert.equal((await table.listIndices()).length, 3);
    assert.equal((await table.query().where("id = 'row-0'").select(["content"]).toArray())[0]?.content, "lumiverse updated native engine");
    await reopened.dropTable("check");
  } finally { reopened.close(); }
}
