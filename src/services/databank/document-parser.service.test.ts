import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../env";
import { parseDocument } from "./document-parser.service";

const originalDataDir = env.dataDir;
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lumiverse-xml-parser-test-"));
  env.dataDir = dataDir;
  mkdirSync(join(dataDir, "databank", "user-1"), { recursive: true });
});

afterEach(() => {
  env.dataDir = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function writeDocument(name: string, contents: string): void {
  writeFileSync(join(dataDir, "databank", "user-1", name), contents);
}

describe("databank XML parsing", () => {
  test("extracts decoded text in document order", async () => {
    writeDocument(
      "ordered.xml",
      '<?xml version="1.0"?><root>Hello <b>world &amp; friends</b>!<![CDATA[ <done> ]]></root>',
    );

    expect(await parseDocument("user-1", "ordered.xml")).toEqual({
      text: "Hello world & friends ! <done>",
      metadata: { format: "xml", valid: true },
    });
  });

  test("retains lenient text extraction for malformed XML", async () => {
    writeDocument("malformed.xml", "<root><b>Still readable</root>");

    expect(await parseDocument("user-1", "malformed.xml")).toEqual({
      text: "Still readable",
      metadata: { format: "xml", valid: false },
    });
  });
});
