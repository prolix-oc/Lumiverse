import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

test("Android relay migration preserves existing local/direct rows and their legacy payload format", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file(new URL("./migrations/130_android_push_destinations.sql", import.meta.url)).text());
    for (const transport of ["local", "fcm"]) db.query(`INSERT INTO android_push_destinations
      (id,user_id,device_id,transport,device_token,project_id,server_origin,token_hash,registered_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(transport, "owner", transport, transport, transport === "fcm" ? "existing-token" : null,
        transport === "fcm" ? "custom-project" : null, "https://chat.example", transport + "-hash", 12345);
    db.exec(await Bun.file(new URL("./migrations/133_android_notification_relay.sql", import.meta.url)).text());
    const rows = db.query("SELECT * FROM android_push_destinations ORDER BY id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "fcm", device_token: "existing-token", project_id: "custom-project", registered_at: 12345,
      delivery_mode: "direct", package_name: "chat.lumiverse.prototype", encryption_key: null, enrollment_id: null });
    expect(rows[1]).toMatchObject({ id: "local", transport: "local", token_hash: "local-hash", encryption_key: null });
  } finally { db.close(); }
});
