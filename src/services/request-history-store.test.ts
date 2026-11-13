import { describe, expect, test } from "bun:test";
import { RequestHistoryStore, REQUEST_HISTORY_MAX_BODY_BYTES } from "./request-history-store";
import { redactRequestValue } from "../utils/redact-request";
import { OMITTED_CAPTURE_MEDIA } from "../utils/omit-capture-media";

const context = { origin: { kind: "chat" as const, name: "Chat", operation: "normal" }, generationId: "generation-1" };
const snapshot = (body: unknown, credentials: string[] = []) => ({ body: JSON.stringify(body), provider: "custom", model: "model-1", credentials });

describe("request history retention", () => {
  test("capture-backed requests omit pixels and opaque failure bodies without hiding the whole prompt", () => {
    const store = new RequestHistoryStore();
    const id = store.record("alice", { ...context, origin: { ...context.origin, sensitiveMedia: true } }, snapshot({ image: "private-pixels" }))!;
    store.completeResponse("alice", id, { body: "private-screen-transcription", bodyBytes: 28, outcome: "failed", error: "private-screen-error" }, []);
    const row = store.get("alice", id)!;
    expect(JSON.parse(row.bodyJson!)).toEqual({ image: OMITTED_CAPTURE_MEDIA });
    expect(row.responseBody).toBeNull();
    expect(row.responseError).toBeNull();
    expect(row.redacted).toBe(true);
    expect(row.response.redacted).toBe(true);
    expect(JSON.stringify(row)).not.toContain("private-");
  });

  test("capture history keeps character instructions, speech, and successful response text with credential redaction", () => {
    const store = new RequestHistoryStore();
    const body = { systemInstruction: { parts: [{ text: "You are Aster. Personality: dry and reserved." }] },
      contents: [{ role: "user", parts: [{ text: "Typed direction\n\nTranscribed speech" },
        { inlineData: { mimeType: "video/mp4", data: "private-video-bytes" } },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,cHJpdmF0ZQ==" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "private-image-bytes" } }] }],
      api_key: "private-credential" };
    const original = JSON.stringify(body);
    const id = store.record("alice", { ...context, origin: { ...context.origin, sensitiveMedia: true } }, snapshot(body, ["private-credential"]))!;
    store.responseHeaders("alice", id, 200);
    store.completeResponse("alice", id, { body: JSON.stringify({ choices: [{ message: { content: "A reserved reply. private-credential" } }] }),
      bodyBytes: 100, outcome: "complete" }, ["private-credential"]);
    const row = store.get("alice", id)!;
    expect(row.bodyJson).toContain("You are Aster. Personality: dry and reserved.");
    expect(JSON.parse(row.bodyJson!).contents[0].parts[0].text).toBe("Typed direction\n\nTranscribed speech");
    expect(row.bodyJson).toContain(OMITTED_CAPTURE_MEDIA);
    expect(row.bodyUnavailable).toBeUndefined();
    expect(row.responseBody).toContain("A reserved reply.");
    expect(row.responseBody).toContain("[REDACTED]");
    expect(JSON.stringify(row)).not.toContain("private-");
    expect(JSON.stringify(row)).not.toContain("cHJpdmF0ZQ==");
    expect(JSON.stringify(body)).toBe(original);
  });

  test("successful capture responses omit echoed media in provider fields, embedded JSON, and text", () => {
    const store = new RequestHistoryStore();
    const body = { choices: [{ message: { content: "An inspectable reply. data:video/mp4;base64,cHJpdmF0ZQ==" } }],
      image_url: "data:image/png;base64,cHJpdmF0ZQ==",
      inlineData: { mimeType: "image/png", data: "private-inline-image" },
      file_data: "private-file-data", input_audio: { data: "private-audio" },
      tool_arguments: JSON.stringify({ video_url: { url: "private-video-url" } }) };
    const original = JSON.stringify(body);
    const id = store.record("alice", { ...context, origin: { ...context.origin, sensitiveMedia: true } }, snapshot({ prompt: "Read this screen" }))!;
    store.completeResponse("alice", id, { body: original, bodyBytes: original.length, outcome: "complete" }, []);
    const row = store.get("alice", id)!;
    expect(row.responseBody).toContain("An inspectable reply.");
    expect(row.responseBody).toContain(OMITTED_CAPTURE_MEDIA);
    expect(row.responseBody).not.toContain("private-");
    expect(row.responseBody).not.toContain("cHJpdmF0ZQ==");
    expect(row.response.bodyUnavailable).toBeUndefined();
    expect(JSON.stringify(body)).toBe(original);
  });

  test("capture provider errors stay private even when HTTP and transport report success", () => {
    for (const body of ['{"error":{"message":"opaque-private-capture-fragment"}}',
      'data: {"error":{"message":"opaque-private-capture-fragment"}}\n\ndata: [DONE]\n\n']) {
      const store = new RequestHistoryStore();
      const id = store.record("alice", { ...context, origin: { ...context.origin, sensitiveMedia: true } }, snapshot({ prompt: "Read this screen" }))!;
      store.responseHeaders("alice", id, 200);
      store.completeResponse("alice", id, { body, bodyBytes: body.length, outcome: "complete" }, []);
      const row = store.get("alice", id)!;
      expect(row.response.state).toBe("failed");
      expect(row.responseBody).toBeNull();
      expect(row.response.bodyUnavailable).toBe("unavailable");
      expect(JSON.stringify(row)).not.toContain("opaque-private");
    }
  });

  test("large capture payloads are sanitized before the retained-body limit, while SSE responses remain readable", () => {
    const store = new RequestHistoryStore();
    const id = store.record("alice", { ...context, origin: { ...context.origin, sensitiveMedia: true } }, snapshot({
      messages: [{ role: "system", content: "Selected character instructions" }, { role: "user", content: [
        { type: "text", text: "The full spoken question" },
        { type: "video_url", video_url: { url: "data:video/mp4;base64," + "A".repeat(REQUEST_HISTORY_MAX_BODY_BYTES) } },
      ] }],
    }))!;
    store.completeResponse("alice", id, { body: 'data: {"choices":[{"delta":{"content":"In character."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      bodyBytes: 100, outcome: "complete" }, []);
    const row = store.get("alice", id)!;
    expect(row.bodyBytes).toBeGreaterThan(REQUEST_HISTORY_MAX_BODY_BYTES);
    expect(row.bodyUnavailable).toBeUndefined();
    expect(row.bodyJson!.length).toBeLessThan(1000);
    expect(row.bodyJson).toContain("Selected character instructions");
    expect(row.bodyJson).toContain("The full spoken question");
    expect(row.responseBody).toContain("In character.");
    expect(row.response.bodyUnavailable).toBeUndefined();
  });
  test("retains exactly the newest 20 dispatches, with separate user buffers and detached results", () => {
    const store = new RequestHistoryStore();
    store.record("alice", context, snapshot({ sequence: 0 }));
    const oldestId = store.list("alice")[0].id;
    for (let sequence = 1; sequence < 25; sequence++) store.record("alice", context, snapshot({ sequence }));
    store.record("bob", context, snapshot({ private: "bob" }));
    expect(store.list("alice")).toHaveLength(20);
    expect(store.list("alice").map((row) => JSON.parse(store.get("alice", row.id)!.bodyJson!).sequence)).toEqual(
      Array.from({ length: 20 }, (_, i) => 24 - i),
    );
    expect(store.get("alice", oldestId)).toBeNull();
    const bob = store.list("bob")[0];
    expect(store.get("alice", bob.id)).toBeNull();
    expect("bodyJson" in bob).toBe(false);
    bob.origin.name = "modified";
    expect(store.get("bob", bob.id)!.origin.name).toBe("Chat");
    store.clear("alice");
    expect(store.list("alice")).toEqual([]);
    expect(store.list("bob")).toHaveLength(1);
  });

  test("marks oversized and invalid bodies unavailable without storing fragments", () => {
    const store = new RequestHistoryStore();
    store.record("alice", context, snapshot({ text: "x".repeat(REQUEST_HISTORY_MAX_BODY_BYTES) }));
    let row = store.get("alice", store.list("alice")[0].id)!;
    expect(row.bodyJson).toBeNull();
    expect(row.bodyUnavailable).toBe("too_large");
    store.record("alice", context, { ...snapshot({}), body: '{"api_key":"never-display-this"' });
    row = store.get("alice", store.list("alice")[0].id)!;
    expect(row.bodyJson).toBeNull();
    expect(row.bodyUnavailable).toBe("unavailable");
    expect(JSON.stringify(row)).not.toContain("never-display-this");
  });

  test("records tool rounds and concurrent sends individually under a shared generation", async () => {
    const store = new RequestHistoryStore();
    await Promise.all(Array.from({ length: 40 }, async (_, round) => {
      await Promise.resolve();
      store.record("alice", context, snapshot({ round }));
    }));
    const rows = store.list("alice");
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.id)).size).toBe(20);
    expect(rows.every((row) => row.generationId === "generation-1")).toBe(true);
    expect(rows.every((row) => row.sentAt <= Date.now())).toBe(true);
  });
});

describe("credential redaction", () => {
  test("redacts nested fields, embedded JSON, keys, URL values, and metadata without changing input", () => {
    const credential = 'provider-secret-with-"quotes"/and+symbols';
    const other = "unrelated-custom-secret";
    const body = {
      api_key: other, max_tokens: 100, top_p: 0.9,
      messages: [{ role: "user", content: `value ${credential} and ${other}` }],
      tools: [{ arguments: JSON.stringify({ credentials: { key: other }, value: credential }) }],
      nested: [{ "X-Api-Key": other, clientSecret: other, Authorization: `Bearer ${other}` }],
      url: `https://example.test?key=${other}&page=1`,
      [credential]: "secret property name",
    };
    const original = JSON.stringify(body);
    const store = new RequestHistoryStore();
    store.record("alice", { ...context, origin: { kind: "extension", name: credential, extensionId: credential } }, {
      ...snapshot(body, [credential]), model: credential,
    });
    const row = store.get("alice", store.list("alice")[0].id)!;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(other);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(row.redacted).toBe(true);
    expect(JSON.parse(row.bodyJson!).max_tokens).toBe(100);
    expect(JSON.parse(row.bodyJson!).top_p).toBe(0.9);
    expect(JSON.stringify(body)).toBe(original);
    expect(JSON.parse(JSON.parse(row.bodyJson!).tools[0].arguments).credentials).toBe("[REDACTED]");
  });

  test("redacts service-account private keys and encoded resolved credentials", () => {
    const secret = "a/private+credential=with-symbols";
    const account = JSON.stringify({ project_id: "demo", private_key: secret, client_email: "test@example.test" });
    const safe = redactRequestValue({ text: secret, encoded: encodeURIComponent(secret), account, project: "demo" }, [account]);
    expect(JSON.stringify(safe)).not.toContain("credential");
    expect((safe as any).project).toBe("demo");
  });

  test("recognizes credentials inside plain text even without a named object field", () => {
    const safe = redactRequestValue({ text: "api_key=unknown-credential Bearer bearer-credential https://example.test?access_token=url-credential" }, []);
    expect(JSON.stringify(safe)).not.toContain("credential");
  });

  test("redacts provider-prefixed credential fields and their copies without changing token limits", () => {
    const safe = redactRequestValue({
      google_api_key: "custom-google-credential", providerAccessToken: "custom-provider-credential",
      text: "custom-google-credential api_key=custom-provider-credential",
      max_output_tokens: 4000, token_limit: 100,
    }, []) as any;
    expect(safe.google_api_key).toBe("[REDACTED]");
    expect(safe.providerAccessToken).toBe("[REDACTED]");
    expect(safe.text).toBe("[REDACTED] api_key=[REDACTED]");
    expect(safe.max_output_tokens).toBe(4000);
    expect(safe.token_limit).toBe(100);
  });
});
