import { describe, expect, test } from "bun:test";
import { parseWebPage, WebPageParseError } from "./web-page-parser";

describe("parseWebPage", () => {
  test("extracts readable plain text and metadata", () => {
    const parsed = parseWebPage(`
      <!doctype html>
      <html>
        <head><title>Heartbeat-safe search</title></head>
        <body>
          <article>
            <h1>Heartbeat-safe search</h1>
            <p>Web search parsing runs away from the server event loop.</p>
            <p>The websocket can keep answering ping messages while parsing.</p>
          </article>
        </body>
      </html>
    `, "https://example.com/article");

    expect(parsed.title).toContain("Heartbeat-safe search");
    expect(parsed.content).toContain("Web search parsing runs away");
    expect(parsed.content).not.toContain("<p>");
  });

  test("reports pages without readable content", () => {
    expect(() => parseWebPage(
      "<!doctype html><html><head><title>Empty</title></head><body></body></html>",
      "https://example.com/empty",
    )).toThrow(WebPageParseError);
  });
});
