import { describe, expect, test } from "bun:test";
import { substituteCharacterPromptMacro, substitutePersonaPromptMacro } from "./image-gen.service";

describe("substituteCharacterPromptMacro", () => {
  test("replaces {{character_prompt}} with the bound character preset text", () => {
    const out = substituteCharacterPromptMacro(
      "a cinematic shot featuring {{character_prompt}}, dramatic lighting",
      "",
      "1girl, long red hair, leather jacket",
      "",
    );
    expect(out.prompt).toBe("a cinematic shot featuring 1girl, long red hair, leather jacket, dramatic lighting");
    expect(out.negativePrompt).toBe("");
  });

  test("is case-insensitive and tolerates internal whitespace", () => {
    const out = substituteCharacterPromptMacro(
      "intro {{ Character_Prompt }} outro",
      "",
      "Aria",
      "",
    );
    expect(out.prompt).toBe("intro Aria outro");
  });

  test("substitutes the negative placeholder independently", () => {
    const out = substituteCharacterPromptMacro(
      "scene",
      "blurry, {{character_negative_prompt}}, low quality",
      "",
      "extra fingers, deformed hands",
    );
    expect(out.negativePrompt).toBe("blurry, extra fingers, deformed hands, low quality");
  });

  test("empty character text removes the placeholder entirely", () => {
    const out = substituteCharacterPromptMacro(
      "before {{character_prompt}} after",
      "",
      "",
      "",
    );
    expect(out.prompt).toBe("before  after");
  });

  test("replaces every occurrence", () => {
    const out = substituteCharacterPromptMacro(
      "{{character_prompt}} and {{character_prompt}}",
      "",
      "Mia",
      "",
    );
    expect(out.prompt).toBe("Mia and Mia");
  });

  test("leaves text without placeholders untouched", () => {
    const out = substituteCharacterPromptMacro(
      "no macros here",
      "no macros there",
      "ignored",
      "ignored",
    );
    expect(out.prompt).toBe("no macros here");
    expect(out.negativePrompt).toBe("no macros there");
  });
});

describe("substitutePersonaPromptMacro", () => {
  test("replaces {{persona_prompt}} with the bound persona preset text", () => {
    const out = substitutePersonaPromptMacro(
      "a portrait of {{persona_prompt}} reading a book",
      "",
      "Aria, brown bob, glasses, librarian outfit",
      "",
    );
    expect(out.prompt).toBe("a portrait of Aria, brown bob, glasses, librarian outfit reading a book");
  });

  test("substitutes the negative placeholder independently", () => {
    const out = substitutePersonaPromptMacro(
      "scene",
      "blurry, {{persona_negative_prompt}}, low quality",
      "",
      "wrong age, wrong hair",
    );
    expect(out.negativePrompt).toBe("blurry, wrong age, wrong hair, low quality");
  });

  test("is case-insensitive and tolerates internal whitespace", () => {
    const out = substitutePersonaPromptMacro(
      "intro {{ Persona_Prompt }} outro",
      "",
      "Mei",
      "",
    );
    expect(out.prompt).toBe("intro Mei outro");
  });

  test("character and persona macros do not interfere", () => {
    const first = substituteCharacterPromptMacro(
      "{{character_prompt}} meets {{persona_prompt}}",
      "",
      "Aria",
      "",
    );
    expect(first.prompt).toBe("Aria meets {{persona_prompt}}");
    const second = substitutePersonaPromptMacro(first.prompt, first.negativePrompt, "Mei", "");
    expect(second.prompt).toBe("Aria meets Mei");
  });
});
