import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import * as safeFetchModule from "../utils/safe-fetch";

// Keep the real credential encryption, database, dispatchers, and installers.
// Only the identity and remote transports are fixtures; no live account is used.
mock.module("../crypto/init", () => ({ getEncryptionKeyBytes: () => new Uint8Array(32).fill(7) }));
const artifacts = new Map<string, () => Response>();
const requests: Array<{ url: string; authorization: string | null }> = [];
mock.module("../utils/safe-fetch", () => ({
  ...safeFetchModule,
  safeFetch: async (url: string, options?: { headers?: HeadersInit }) => {
    requests.push({ url, authorization: new Headers(options?.headers).get("Authorization") });
    const response = artifacts.get(url);
    if (!response) throw new Error(`Unexpected test URL: ${url}`);
    return response();
  },
}));

const links = await import("../services/lumihub-link.service");
const illarin = await import("../services/illarin-instance.service");
const { autoConnect, deleteLumiHubClient } = await import("./client");
const { runDeliveryCycle } = await import("../illarin/delivery-worker");
const { getPreset } = await import("../services/presets.service");
import type { IllarinDelivery } from "../illarin/types";

const USERS = ["owner", "member"] as const;
const nativeWebSocket = globalThis.WebSocket;

class HubSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static sockets = new Map<string, HubSocket>();
  readyState = HubSocket.CONNECTING;
  private pending = new Map<string, (result: any) => void>();

  constructor(url: string) {
    super();
    HubSocket.sockets.set(new URL(url).searchParams.get("token")!, this);
  }

  open() {
    this.readyState = HubSocket.OPEN;
    this.dispatchEvent(new Event("open"));
    this.receive({ type: "auth_ok", id: "auth", timestamp: Date.now() });
  }

  close() { this.readyState = 3; }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.type === "install_result") {
      this.pending.get(message.replyTo)?.(message.payload);
      this.pending.delete(message.replyTo);
    }
  }

  private receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  install(type: string, payload: unknown): Promise<any> {
    const id = crypto.randomUUID();
    const result = new Promise((resolve) => this.pending.set(id, resolve));
    this.receive({ type, id, payload, timestamp: Date.now() });
    return result;
  }
}

beforeEach(async () => {
  closeDatabase();
  await runMigrations(initDatabase(":memory:"));
  getDb().run("PRAGMA foreign_keys = ON");
  for (const [index, userId] of USERS.entries()) {
    getDb().query('INSERT INTO "user" (id, name, email, role, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(userId, userId, `${userId}@example.test`, index === 0 ? "owner" : "user", index + 1);
  }
  globalThis.WebSocket = HubSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  for (const userId of USERS) deleteLumiHubClient(userId);
  globalThis.WebSocket = nativeWebSocket;
  HubSocket.sockets.clear();
  artifacts.clear();
  requests.length = 0;
  links.invalidateLumiHubKeyCache();
  illarin.invalidateIllarinKeyCache();
  closeDatabase();
});

const card = { spec: "chara_card_v3", spec_version: "3.0", data: { name: "Shared card", description: "Test" } };
const lorebook = { name: "Shared book", description: "", entries: [{ keys: ["test"], content: "Test entry" }] };
const preset = { name: "Shared preset", blocks: [], regex_scripts: [{ name: "Bundled", find_regex: "test" }] };
const theme = { theme: { name: "Shared theme", mode: "dark", accent: { h: 270, s: 50, l: 50 } }, assets: [] };

function count(table: string, userId: string): number {
  return (getDb().query(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId) as { count: number }).count;
}

describe("remote installs with an owner and a separately linked member", () => {
  test("reconnects both LumiHub links and installs the same assets into separate libraries", async () => {
    for (const userId of USERS) {
      await links.saveLinkConfig(userId, "https://hub.example.test", "wss://hub.example.test/ws", `hub-${userId}`, `instance-${userId}`, userId);
    }
    await autoConnect();
    expect(HubSocket.sockets.size).toBe(2);

    for (const userId of USERS) {
      const socket = HubSocket.sockets.get(`hub-${userId}`)!;
      socket.open();
      for (const [type, payload] of [
        ["character", { characterId: "card", characterName: "Shared card", cardData: card }],
        ["worldbook", { worldbookId: "book", worldbookName: "Shared book", worldbookData: lorebook }],
        ["preset", { presetId: "preset", presetName: "Shared preset", presetData: { preset } }],
        ["theme", { themeId: "theme", themeName: "Shared theme", themeData: theme }],
      ] as const) {
        const result = await socket.install(`install_${type}`, { source: "lumihub", ...payload });
        expect(result).toMatchObject({ success: true });
      }
      expect(count("characters", userId)).toBe(1);
      expect(count("world_books", userId)).toBe(1);
      expect(count("presets", userId)).toBe(1);
      expect(count("regex_scripts", userId)).toBe(1);
      expect(count("settings", userId)).toBeGreaterThanOrEqual(3);
    }

    // A member reconnecting must not remove the owner's encrypted credentials.
    await links.saveLinkConfig("member", "https://hub.example.test", "wss://hub.example.test/ws", "member-new", "member-new", "Member");
    expect((await links.getLinkConfig("owner"))?.linkToken).toBe("hub-owner");
  });

  test("fetches sealed preset content with each user's own persisted LumiHub token", async () => {
    const content = "Sealed content";
    const digest = createHash("sha256").update(content).digest("hex");
    const url = "https://hub.example.test/api/v1/presets/sealed/sealed-blocks?version=1.0.0";
    artifacts.set(url, () => Response.json({ blocks: { private: content } }));
    for (const userId of USERS) {
      await links.saveLinkConfig(userId, "https://hub.example.test", "wss://hub.example.test/ws", `hub-${userId}`, `instance-${userId}`, userId);
    }
    await autoConnect();
    for (const userId of USERS) {
      const socket = HubSocket.sockets.get(`hub-${userId}`)!;
      socket.open();
      const result = await socket.install("install_preset", {
        source: "lumihub", presetId: "sealed", presetName: "Sealed", presetVersion: "1.0.0",
        presetData: { preset: { name: "Sealed", blocks: [{ id: "private", name: "Private", content: "{{presetBlock::private}}" }] } },
        sealedPreset: { version: "1.0.0", blocks: [{ key: "private", sha256: digest }] },
      });
      expect(result).toMatchObject({ success: true });
      expect(getPreset(userId, result.presetId)?.prompt_order[0].content).toBe(content);
      expect(getPreset(userId === "owner" ? "member" : "owner", result.presetId)).toBeNull();
    }
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer hub-owner", "Bearer hub-member"]);
  });

  test("collects Illarin deliveries with separate tokens and persists separate content and receipts", async () => {
    const fixtures = [
      ["character", card], ["lorebook", lorebook], ["preset", preset],
      ["theme", theme], ["pack", { name: "Shared pack", lumiaItems: [{ name: "Lumia" }] }],
    ] as const;
    const deliveries: IllarinDelivery[] = fixtures.map(([kind, data]) => {
      const url = `https://artifacts.example.test/${kind}`;
      artifacts.set(url, () => kind === "theme"
        ? new Response(new Uint8Array(zipSync({ "theme.json": new TextEncoder().encode(JSON.stringify(data)) })))
        : Response.json(data));
      return {
        id: `delivery-${kind}`, workId: `asset-${kind}`, versionNumber: 1,
        type: kind, name: `Shared ${kind}`, format: "raw", label: "Test",
        queuedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        files: [{ type: "export", url }],
      };
    });

    for (const userId of USERS) {
      await illarin.saveInstance({
        userId, illarinUrl: "https://illarin.example.test", instanceName: userId,
        applicationName: "Lumiverse", declarationJson: "{}",
        pair: {
          accessToken: `access-${userId}`, refreshToken: `refresh-${userId}`,
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          connectedApp: { id: `instance-${userId}`, permissions: ["work:receive"] },
        },
      });
      artifacts.set("https://illarin.example.test/api/v1/sends/collect", () => Response.json({ sends: deliveries, takedowns: [] }));
      expect(await runDeliveryCycle(userId)).toEqual({ status: "continue", installed: 5, failed: 0 });
      for (const table of ["characters", "world_books", "presets", "packs", "regex_scripts"]) {
        expect(count(table, userId)).toBe(1);
      }
      expect(count("illarin_delivery_receipt", userId)).toBe(5);
    }
    expect(requests.filter((request) => request.url.includes("/collect")).map((request) => request.authorization))
      .toEqual(["Bearer access-owner", "Bearer access-member"]);
  });
});
