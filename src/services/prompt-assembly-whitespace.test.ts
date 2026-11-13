import { beforeAll, describe, expect, test } from "bun:test";

import { evaluate, initMacros, registry, type MacroEnv } from "../macros";
import type { AssemblyBreakdownEntry } from "../llm/types";
import {
  attributeExpandedMarkerWorldInfoTokens,
  evaluatePromptBlockTokenCountContent,
  normalizePromptBlockText,
} from "./prompt-assembly.service";

function makeEnv(): MacroEnv {
  return {
    commit: false,
    names: {
      user: "User",
      char: "Assistant",
      group: "",
      groupNotMuted: "",
      notChar: "User",
      charGroupFocused: "",
      groupOthers: "",
      groupMemberCount: "0",
      isGroupChat: "no",
      isNarrator: "no",
      groupLastSpeaker: "",
      groupCardMode: "solo",
    },
    character: {
      name: "Assistant",
      description: "",
      personality: "",
      scenario: "",
      persona: "",
      personaSubjectivePronoun: "",
      personaObjectivePronoun: "",
      personaPossessivePronoun: "",
      personaReflexivePronoun: "",
      personaPossessivePronounStandalone: "",
      mesExamples: "",
      mesExamplesRaw: "",
      systemPrompt: "",
      postHistoryInstructions: "",
      depthPrompt: "",
      creatorNotes: "",
      version: "",
      creator: "",
      firstMessage: "",
    },
    chat: {
      id: "chat-1",
      messageCount: 0,
      lastMessage: "",
      lastMessageName: "",
      lastUserMessage: "",
      lastCharMessage: "",
      lastMessageId: 0,
      firstIncludedMessageId: 0,
      lastSwipeId: 0,
      currentSwipeId: 0,
      rejectedSwipe: "",
    },
    system: {
      model: "test",
      maxPrompt: 4096,
      maxContext: 8192,
      maxResponse: 512,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: {
      local: new Map(),
      global: new Map(),
      chat: new Map(),
    },
    dynamicMacros: {},
    extra: { messages: [] },
  };
}

describe("normalizePromptBlockText", () => {
  beforeAll(() => {
    initMacros();
  });

  test("collapses newline piles left by empty optional macros", async () => {
    const template = `<self_reasoning>
Alright.
{{description}}

{{personality}}

{{scenario}}
{{persona}}

{{if::0}}Council{{else}}{{/if}}{{trim}}
After
</self_reasoning>`;

    const raw = (await evaluate(template, makeEnv(), registry)).text;
    expect(raw).toContain("Alright.\n\n\n");
    expect(raw).toContain("\n\n\nAfter");

    expect(normalizePromptBlockText(raw)).toBe(
      "<self_reasoning>\nAlright.\n\nAfter\n</self_reasoning>",
    );
  });

  test("resolves wiMarker normally but suppresses it in token-count content", async () => {
    const env = makeEnv();
    env.extra.worldInfoAtMarker = "Eight chars";
    const template = "Prompt header\n{{wiMarker}}\nPrompt footer";

    expect((await evaluate(template, env, registry)).text).toContain("Eight chars");
    expect(await evaluatePromptBlockTokenCountContent(template, env, {
      id: "marker-block",
      role: "system",
      position: "pre_history",
      depth: 0,
    })).toBe("Prompt header\n\nPrompt footer");
  });

  test("counts marker WI only when an emitted breakdown block expanded it", () => {
    const markerEntry = {
      type: "world_info" as const,
      name: "WI At Marker: Entry",
      content: "World info",
      marker: "wi_marker",
      excludeFromTotal: true,
    };
    const breakdown: AssemblyBreakdownEntry[] = [markerEntry];

    attributeExpandedMarkerWorldInfoTokens(breakdown);
    expect(markerEntry.excludeFromTotal).toBe(true);

    breakdown.unshift({
      type: "block",
      name: "Activated WI",
      content: "Header\nWorld info",
      tokenCountContent: "Header",
      attributesWorldInfoMarkerTokens: true,
    });
    attributeExpandedMarkerWorldInfoTokens(breakdown);
    expect(markerEntry.excludeFromTotal).toBeUndefined();
  });
});
