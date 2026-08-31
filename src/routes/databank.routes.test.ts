import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import * as databank from "../services/databank";
import type { DatabankDocument } from "../services/databank/types";
import {
  UserDataBarrierBusyError,
  withUserDataExportSync,
} from "../services/user-data/snapshot";
import { databankRoutes } from "./databank.routes";

const USER_ID = "databank-route-user";
const FOREIGN_USER_ID = "databank-route-foreign-user";
const CHAT_ID = "databank-route-chat";
const CHARACTER_ID = "databank-route-character";
const UNRELATED_CHAT_ID = "databank-route-unrelated-chat";

const ACTIVE_BANK_ID = "cross-ref-bank";
const DISABLED_BANK_ID = "disabled-cross-ref-bank";
const FOREIGN_BANK_ID = "foreign-cross-ref-bank";

const ACTIVE_SLUG = "route-parity-active";
const DISABLED_SLUG = "route-parity-disabled";
const FOREIGN_SLUG = "route-parity-foreign";
const ACTIVE_CONTENT = "Content from the chat cross-referenced document.";

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/", databankRoutes);

function seedBankWithDocument(input: {
  bankId: string;
  documentId: string;
  userId: string;
  enabled: boolean;
  slug: string;
  name: string;
  content: string;
}): void {
  const now = 1_700_000_000;
  getDb().query(
    `INSERT INTO databanks (
      id, user_id, name, description, scope, scope_id, enabled, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, '', 'chat', ?, ?, '{}', ?, ?)`,
  ).run(
    input.bankId,
    input.userId,
    `${input.name} Bank`,
    UNRELATED_CHAT_ID,
    input.enabled ? 1 : 0,
    now,
    now,
  );
  getDb().query(
    `INSERT INTO databank_documents (
      id, databank_id, user_id, name, slug, file_path, mime_type, file_size,
      content_hash, total_chunks, status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, 1, 'ready', '{}', ?, ?)`,
  ).run(
    input.documentId,
    input.bankId,
    input.userId,
    input.name,
    input.slug,
    `/test/${input.documentId}.txt`,
    input.content.length,
    `${input.documentId}-hash`,
    now,
    now,
  );
  getDb().query(
    `INSERT INTO databank_chunks (
      id, document_id, databank_id, user_id, chunk_index, content, token_count,
      metadata, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, 8, '{}', ?)`,
  ).run(
    `${input.documentId}-chunk`,
    input.documentId,
    input.bankId,
    input.userId,
    input.content,
    now,
  );
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());

  getDb().query(
    "INSERT INTO characters (id, name, extensions, user_id) VALUES (?, ?, '{}', ?)",
  ).run(CHARACTER_ID, "Route Character", USER_ID);
  getDb().query(
    "INSERT INTO chats (id, character_id, name, metadata, user_id) VALUES (?, ?, ?, ?, ?)",
  ).run(
    CHAT_ID,
    CHARACTER_ID,
    "Route Chat",
    JSON.stringify({
      chat_databank_ids: [ACTIVE_BANK_ID, DISABLED_BANK_ID, FOREIGN_BANK_ID],
    }),
    USER_ID,
  );

  seedBankWithDocument({
    bankId: ACTIVE_BANK_ID,
    documentId: "active-document",
    userId: USER_ID,
    enabled: true,
    slug: ACTIVE_SLUG,
    name: "Route Parity Active",
    content: ACTIVE_CONTENT,
  });
  seedBankWithDocument({
    bankId: DISABLED_BANK_ID,
    documentId: "disabled-document",
    userId: USER_ID,
    enabled: false,
    slug: DISABLED_SLUG,
    name: "Route Parity Disabled",
    content: "Disabled content must remain unavailable.",
  });
  seedBankWithDocument({
    bankId: FOREIGN_BANK_ID,
    documentId: "foreign-document",
    userId: FOREIGN_USER_ID,
    enabled: true,
    slug: FOREIGN_SLUG,
    name: "Route Parity Foreign",
    content: "Foreign content must remain unavailable.",
  });
});

afterEach(() => closeDatabase());

describe("databank mention routes", () => {
  test("GET /mentions/autocomplete uses persisted chat cross-references and rejects disabled or foreign documents", async () => {
    const response = await app.request(
      `/mentions/autocomplete?q=route-parity&chatId=${encodeURIComponent(CHAT_ID)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          slug: ACTIVE_SLUG,
          name: "Route Parity Active",
          databankId: ACTIVE_BANK_ID,
          databankName: "Route Parity Active Bank",
        },
      ],
    });
  });

  test("POST /mentions/resolve uses persisted chat cross-references and rejects disabled or foreign documents", async () => {
    const resolve = (slug: string) => app.request("/mentions/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, chatId: CHAT_ID }),
    });

    const activeResponse = await resolve(ACTIVE_SLUG);
    expect(activeResponse.status).toBe(200);
    expect(await activeResponse.json()).toEqual({
      slug: ACTIVE_SLUG,
      documentName: "Route Parity Active",
      content: ACTIVE_CONTENT,
      truncated: false,
    });

    for (const slug of [DISABLED_SLUG, FOREIGN_SLUG]) {
      const rejectedResponse = await resolve(slug);
      expect(rejectedResponse.status).toBe(404);
      expect(await rejectedResponse.json()).toEqual({ error: "Document not found" });
    }
  });
});

describe("databank scrape ingestion", () => {
  test("publishes the pending row before starting one native processing run", async () => {
    const originalDataDir = env.dataDir;
    const dataDir = mkdtempSync(join(tmpdir(), "lumiverse-databank-scrape-route-"));
    const scrapeSpy = spyOn(databank, "scrapeUrl").mockResolvedValue({
      title: "Committed scrape",
      url: "https://example.test/committed",
      content: "Scraped route content.",
      sourceType: "web",
      contentLength: 22,
      metadata: {},
    });
    let processingDocument: DatabankDocument | null = null;
    let mutationContextExited = false;
    const processSpy = spyOn(databank, "processDocument").mockImplementation(async (userId, documentId) => {
      try {
        withUserDataExportSync(userId, () => {});
      } catch (error) {
        mutationContextExited = error instanceof UserDataBarrierBusyError;
      }
      processingDocument = databank.getDocument(userId, documentId);
    });

    try {
      env.dataDir = dataDir;
      const response = await app.request(
        "/cross-ref-bank/documents/scrape",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.test/committed" }),
        },
      );
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        databankId: ACTIVE_BANK_ID,
        status: "pending",
        scraped: {
          title: "Committed scrape",
          sourceType: "web",
          contentLength: 22,
        },
      });
      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith(USER_ID, body.id);
      expect(mutationContextExited).toBe(true);
      expect(processingDocument).toMatchObject({
        id: body.id,
        databankId: ACTIVE_BANK_ID,
        status: "pending",
      });
    } finally {
      processSpy.mockRestore();
      scrapeSpy.mockRestore();
      env.dataDir = originalDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
