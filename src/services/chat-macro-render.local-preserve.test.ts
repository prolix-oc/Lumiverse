import { describe, expect, test } from "bun:test";
import { buildPersistedMacroVariables } from "./chat-macro-render.service";

describe("buildPersistedMacroVariables", () => {
  test("preserves stored local untouched while merging incoming global", () => {
    const existing = {
      local: { exp: "50", ui_lang: "1", setup_complete: "1" },
      global: { theme: "noir" },
    };

    const out = buildPersistedMacroVariables(existing, { theme: "neon", flag: "on" });

    expect(out.local).toEqual({ exp: "50", ui_lang: "1", setup_complete: "1" });
    expect(out.global).toEqual({ theme: "neon", flag: "on" });
  });

  test("does not invent a local key when none was stored", () => {
    const out = buildPersistedMacroVariables({ global: { a: "1" } }, { b: "2" });
    expect("local" in out).toBe(false);
    expect(out.global).toEqual({ a: "1", b: "2" });
  });

  test("never merges transient env-local back in (caller passes only global)", () => {
    const existing = { local: { kept: "yes" } };
    const out = buildPersistedMacroVariables(existing, {});
    expect(out.local).toEqual({ kept: "yes" });
  });
});
