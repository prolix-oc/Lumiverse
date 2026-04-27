import type { AnyDreamWeaverTool, DreamWeaverTool, ValidateResult } from "./types";
import type { DraftV2, LorebookEntry, NpcEntry, VoiceGuidance } from "../../../types/dream-weaver";

type V<T> = { ok: true; data: T } | { ok: false; error: string };

function asObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function reqString(obj: Record<string, unknown>, key: string, minLen = 1): V<string> {
  const v = obj[key];
  if (typeof v !== "string") return { ok: false, error: `${key}: expected string` };
  if (v.length < minLen) return { ok: false, error: `${key}: too short (min ${minLen})` };
  return { ok: true, data: v };
}

function reqStringArray(
  obj: Record<string, unknown>,
  key: string,
  opts: { min: number; max: number },
): V<string[]> {
  const v = obj[key];
  if (!Array.isArray(v)) return { ok: false, error: `${key}: expected array` };
  if (v.length < opts.min || v.length > opts.max)
    return { ok: false, error: `${key}: length ${opts.min}..${opts.max}` };
  for (const item of v)
    if (typeof item !== "string" || item.length === 0)
      return { ok: false, error: `${key}: items must be non-empty strings` };
  return { ok: true, data: v as string[] };
}

const setName: DreamWeaverTool<{ name: string }> = {
  name: "set_name",
  displayName: "Set Name",
  category: "soul",
  userInvocable: true,
  slashCommand: "/name",
  description: "Generate a grounded character name from the dream.",
  prompt: `Tool: set_name. Pick a single name that fits the dream. Output JSON: { "name": "<string>" }.`,
  validate(input): ValidateResult<{ name: string }> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const name = reqString(o, "name", 1);
    if (!name.ok) return name;
    return { ok: true, data: { name: name.data } };
  },
  conflictMode: "overwrite",
  requiresFragments: ["anti-slop"],
  contextSlice: () => ({}),
  apply: (draft, output) => ({ ...draft, name: output.name }),
};

const setAppearance: DreamWeaverTool<{
  appearance: string;
  appearance_data: Record<string, unknown>;
}> = {
  name: "set_appearance",
  displayName: "Set Appearance",
  category: "soul",
  userInvocable: true,
  slashCommand: "/appearance",
  description: "Generate character appearance using the appearance template.",
  prompt: `Tool: set_appearance. Use the appearance template fragment exactly. Output JSON:
{
  "appearance": "<the full templated appearance string>",
  "appearance_data": { "height": "...", "species": "...", "hair": "...", "eyes": "...", "skin_tone": "..." }
}`,
  validate(input): ValidateResult<{ appearance: string; appearance_data: Record<string, unknown> }> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const appearance = reqString(o, "appearance", 20);
    if (!appearance.ok) return appearance;
    const ad = asObject(o["appearance_data"]);
    if (!ad) return { ok: false, error: "appearance_data: expected object" };
    return { ok: true, data: { appearance: appearance.data, appearance_data: ad } };
  },
  conflictMode: "overwrite",
  requiresFragments: ["anti-slop", "format:appearance"],
  contextSlice: (d) => ({ name: d.name }),
  apply: (draft, output) => ({
    ...draft,
    appearance: output.appearance,
    appearance_data: output.appearance_data,
  }),
};

const setPersonality: DreamWeaverTool<{ personality: string }> = {
  name: "set_personality",
  displayName: "Set Personality",
  category: "soul",
  userInvocable: true,
  slashCommand: "/personality",
  description: "Behavioral patterns, habits, contradictions.",
  prompt: `Tool: set_personality. Write 2-3 paragraphs of behavioral patterns, habits, contradictions. Output JSON: { "personality": "<string>" }.`,
  validate(input): ValidateResult<{ personality: string }> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const personality = reqString(o, "personality", 40);
    if (!personality.ok) return personality;
    return { ok: true, data: { personality: personality.data } };
  },
  conflictMode: "overwrite",
  requiresFragments: ["anti-slop"],
  contextSlice: (d) => ({ name: d.name, appearance: d.appearance, scenario: d.scenario }),
  apply: (draft, output) => ({ ...draft, personality: output.personality }),
};

const setScenario: DreamWeaverTool<{ scenario: string }> = {
  name: "set_scenario",
  displayName: "Set Scenario",
  category: "soul",
  userInvocable: true,
  slashCommand: "/scenario",
  description: "Current situation, tension, relationship to {{user}}.",
  prompt: `Tool: set_scenario. Write the current situation, tension, and relationship to {{user}}. 1-2 paragraphs. Output JSON: { "scenario": "<string>" }.`,
  validate(input): ValidateResult<{ scenario: string }> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const scenario = reqString(o, "scenario", 40);
    if (!scenario.ok) return scenario;
    return { ok: true, data: { scenario: scenario.data } };
  },
  conflictMode: "overwrite",
  requiresFragments: ["anti-slop"],
  contextSlice: (d) => ({ name: d.name, personality: d.personality }),
  apply: (draft, output) => ({ ...draft, scenario: output.scenario }),
};

const setVoiceGuidance: DreamWeaverTool<{ voice_guidance: VoiceGuidance }> = {
  name: "set_voice_guidance",
  displayName: "Set Voice Guidance",
  category: "soul",
  userInvocable: true,
  slashCommand: "/voice",
  description: "How the character speaks.",
  prompt: `Tool: set_voice_guidance. Output JSON: { "voice_guidance": <VoiceGuidance per voice-rules fragment> }.`,
  validate(input): ValidateResult<{ voice_guidance: VoiceGuidance }> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const vg = asObject(o["voice_guidance"]);
    if (!vg) return { ok: false, error: "voice_guidance: expected object" };

    const compiled = reqString(vg, "compiled", 0);
    if (!compiled.ok) return compiled;

    const rules = asObject(vg["rules"]);
    if (!rules) return { ok: false, error: "voice_guidance.rules: expected object" };

    for (const key of ["baseline", "rhythm", "diction", "quirks", "hard_nos"] as const) {
      const arr = rules[key];
      if (!Array.isArray(arr)) return { ok: false, error: `voice_guidance.rules.${key}: expected array` };
      for (const item of arr)
        if (typeof item !== "string")
          return { ok: false, error: `voice_guidance.rules.${key}: items must be strings` };
    }

    return {
      ok: true,
      data: {
        voice_guidance: {
          compiled: compiled.data,
          rules: {
            baseline: rules["baseline"] as string[],
            rhythm: rules["rhythm"] as string[],
            diction: rules["diction"] as string[],
            quirks: rules["quirks"] as string[],
            hard_nos: rules["hard_nos"] as string[],
          },
        },
      },
    };
  },
  conflictMode: "overwrite",
  requiresFragments: ["voice-rules"],
  contextSlice: (d) => ({ name: d.name, personality: d.personality }),
  apply: (draft, output) => ({ ...draft, voice_guidance: output.voice_guidance }),
};

const setFirstMessage: DreamWeaverTool<{ first_mes: string }> = {
  name: "set_first_message",
  displayName: "Set First Message",
  category: "soul",
  userInvocable: true,
  slashCommand: "/first_message",
  description: "Opening message, beginning with action or dialogue.",
  prompt: `Tool: set_first_message. Write the character's opening message — 3-5 paragraphs, beginning with action or dialogue, NOT scene-setting. Output JSON: { "first_mes": "<string>" }.`,
  validate(input): ValidateResult<{ first_mes: string }> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const first_mes = reqString(o, "first_mes", 60);
    if (!first_mes.ok) return first_mes;
    return { ok: true, data: { first_mes: first_mes.data } };
  },
  conflictMode: "overwrite",
  requiresFragments: ["anti-slop"],
  contextSlice: (d) => ({
    name: d.name,
    personality: d.personality,
    scenario: d.scenario,
    voice_guidance: d.voice_guidance,
  }),
  apply: (draft, output) => ({ ...draft, first_mes: output.first_mes }),
};

const setGreeting: DreamWeaverTool<{ greeting: string }> = {
  name: "set_greeting",
  displayName: "Set Greeting",
  category: "soul",
  userInvocable: true,
  slashCommand: "/greeting",
  description: "Alternate entry-point greeting.",
  prompt: `Tool: set_greeting. Write an alternate greeting different from the first message — same character, different opening situation. 2-4 paragraphs. Output JSON: { "greeting": "<string>" }.`,
  validate(input): ValidateResult<{ greeting: string }> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const greeting = reqString(o, "greeting", 40);
    if (!greeting.ok) return greeting;
    return { ok: true, data: { greeting: greeting.data } };
  },
  conflictMode: "overwrite",
  requiresFragments: ["anti-slop"],
  contextSlice: (d) => ({
    name: d.name,
    personality: d.personality,
    scenario: d.scenario,
    first_mes: d.first_mes,
  }),
  apply: (draft, output) => ({ ...draft, greeting: output.greeting }),
};

const addLorebookEntry: DreamWeaverTool<LorebookEntry> = {
  name: "add_lorebook_entry",
  displayName: "Add Lorebook Entry",
  category: "world",
  userInvocable: true,
  slashCommand: "/add_lorebook",
  description: "Add a new lorebook entry to the world.",
  prompt: `Tool: add_lorebook_entry. Generate one new lorebook entry that fits the dream and is distinct from existing entries. Output JSON: { "key": ["<trigger 1>", ...], "comment": "<short title>", "content": "<entry body>" }.`,
  validate(input): ValidateResult<LorebookEntry> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const key = reqStringArray(o, "key", { min: 1, max: 4 });
    if (!key.ok) return key;
    const comment = reqString(o, "comment", 1);
    if (!comment.ok) return comment;
    if (comment.data.length > 80)
      return { ok: false, error: "comment: too long (max 80)" };
    const content = reqString(o, "content", 20);
    if (!content.ok) return content;
    return { ok: true, data: { key: key.data, comment: comment.data, content: content.data } };
  },
  conflictMode: "append",
  requiresFragments: ["anti-slop", "format:lorebook"],
  contextSlice: (d) => ({
    scenario: d.scenario,
    lorebooks: d.lorebooks.map((e) => ({ key: e.key, comment: e.comment, content: "" })) as LorebookEntry[],
  }),
  apply: (draft, output) => ({ ...draft, lorebooks: [...draft.lorebooks, output] }),
};

const addNpc: DreamWeaverTool<NpcEntry> = {
  name: "add_npc",
  displayName: "Add NPC",
  category: "world",
  userInvocable: true,
  slashCommand: "/add_npc",
  description: "Add a new named NPC to the world.",
  prompt: `Tool: add_npc. Generate one new NPC distinct from any existing ones. Output JSON: { "name": "<string>", "description": "<2-3 sentences>", "voice_notes": "<optional>" }.`,
  validate(input): ValidateResult<NpcEntry> {
    const o = asObject(input);
    if (!o) return { ok: false, error: "expected object" };
    const name = reqString(o, "name", 1);
    if (!name.ok) return name;
    const description = reqString(o, "description", 20);
    if (!description.ok) return description;
    if ("voice_notes" in o && o["voice_notes"] !== undefined) {
      if (typeof o["voice_notes"] !== "string")
        return { ok: false, error: "voice_notes: expected string" };
      return {
        ok: true,
        data: { name: name.data, description: description.data, voice_notes: o["voice_notes"] as string },
      };
    }
    return { ok: true, data: { name: name.data, description: description.data } };
  },
  conflictMode: "append",
  requiresFragments: ["anti-slop", "format:npc"],
  contextSlice: (d) => ({
    name: d.name,
    scenario: d.scenario,
    npcs: d.npcs.map((n) => ({ name: n.name, description: "", voice_notes: undefined })) as NpcEntry[],
  }),
  apply: (draft, output) => ({ ...draft, npcs: [...draft.npcs, output] }),
};

export const BUILTIN_TOOLS: AnyDreamWeaverTool[] = [
  setName,
  setAppearance,
  setPersonality,
  setScenario,
  setVoiceGuidance,
  setFirstMessage,
  setGreeting,
  addLorebookEntry,
  addNpc,
];
