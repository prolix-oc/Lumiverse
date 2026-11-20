import { getSession } from "./session.service";
import { getBible } from "./bible.service";
import { getFields } from "./render.service";
import { weaverGenerateJsonWithUsage, weaverGenerateTextWithUsage } from "./llm";
import { getPersonaRegister } from "./persona-register";
import * as personasSvc from "../personas.service";
import { createWorldBook, createEntry } from "../world-books.service";
import type { Persona } from "../../types/persona";
import type {
  PersonaDraft,
  PersonaDraftSection,
  WeaverField,
  WeaverSession,
} from "../../types/weaver";

export interface PersonaSectionDef {
  id: string;
  label: string;
  guidance: string;
}

export const PERSONA_SECTIONS: readonly PersonaSectionDef[] = [
  {
    id: "identity",
    label: "Identity",
    guidance:
      "Who they are at the core: the one-line vibe, what they read as at a glance, age/gender where it matters. Not the name (that is separate).",
  },
  {
    id: "appearance",
    label: "Appearance",
    guidance:
      "A lean physical read — build/height, hair, eyes, the signature clothing or item that fixes them. Only what matters at a glance, never a full spec sheet.",
  },
  {
    id: "personality",
    label: "Personality",
    guidance:
      "How they behave and relate: a few sharp, specific traits; how they carry themselves; how they treat the people around them.",
  },
  {
    id: "drive",
    label: "Drive",
    guidance:
      "The one or two wants that actually pull them through a scene. Concrete, not abstract virtues.",
  },
];

export function serializePersonaBody(sections: readonly PersonaDraftSection[]): string {
  return sections
    .filter((s) => s.lines.some((l) => l.trim()))
    .map((s) => {
      const bullets = s.lines
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => `- ${l}`)
        .join("\n");
      return `## ${s.label}\n${bullets}`;
    })
    .join("\n\n");
}

function fieldText(fields: readonly WeaverField[], name: string): string {
  return fields.find((f) => f.field_name === name)?.content.trim() ?? "";
}

function buildHostContextBlock(userId: string, session: WeaverSession): string {
  const bible = getBible(userId, session.id);
  const fields = getFields(userId, session.id);
  const brief = bible?.spine.brief?.trim() ?? "";
  const name = fieldText(fields, "name");
  const description = fieldText(fields, "description");
  const voice = fieldText(fields, "personality");

  const parts: string[] = [];
  if (brief) parts.push(`BRIEF: ${brief}`);
  if (name) parts.push(`NAME: ${name}`);
  if (description) parts.push(`DESCRIPTION:\n${description.slice(0, 1200)}`);
  if (voice) parts.push(`VOICE:\n${voice.slice(0, 800)}`);
  if (parts.length === 0) return "";

  return `THE BUILD THIS PERSONA ACCOMPANIES — design the persona to COMPLEMENT or FRICTION against it, but keep the persona reusable: do NOT bake this build's proper names into the persona body.\n\n${parts.join("\n\n")}`;
}

function buildGenerateSystemPrompt(): string {
  const sections = PERSONA_SECTIONS.map((s) => `- "${s.id}" (${s.label}): ${s.guidance}`).join("\n");
  return `You are the Weaver's persona builder. Turn the author's idea into a USER PERSONA — who the human player is in the roleplay. Writing in the second person about themselves is NOT wanted; describe them plainly.

A persona has two tiers:
- BODY: lean, always-on text injected every turn. Holds ONLY the basic and highest-importance material — keep it tight. It is character-agnostic and reusable across many chats.
- DEPTH: optional, triggered detail that surfaces only on relevance (background, formative events, relationships, secrets). Anything that does not need to be present every single turn goes here, never in the body.

Write the BODY as these sections, each a short list of crisp bullet lines (a few words to one sentence each):
${sections}

Output ONLY JSON, no prose, in exactly this shape:
{
  "name": "the persona's name",
  "pronouns": { "subjective": "she|he|they|…", "objective": "her|him|them|…", "possessive": "her|his|their|…" },
  "sections": [ { "id": "identity", "lines": ["…", "…"] }, … one object per section id above, in order … ],
  "depth": [ { "title": "short label", "content": "1–3 sentences", "keys": ["trigger", "words"] } ]
}

Ground every detail in the author's idea; never drift to the generic. If the idea is sparse, make specific, characterful choices rather than hedging. Put nothing basic or always-relevant into depth. Depth may be an empty array if the idea carries no deeper material.`;
}

function buildGenerateUserMessage(seedText: string, ctx: string): string {
  const parts = [`THE IDEA:\n${seedText.trim() || "(the author left this blank — invent a specific, grounded persona that fits the build it accompanies)"}`];
  if (ctx) parts.push(ctx);
  parts.push("Now write the persona as JSON.");
  return parts.join("\n\n");
}

function coerceLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

function coerceDepth(value: unknown): PersonaDraft["depth"] {
  if (!Array.isArray(value)) return [];
  const out: PersonaDraft["depth"] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const content = typeof r.content === "string" ? r.content.trim() : "";
    if (!content) continue;
    out.push({ title: title || "Detail", content, keys: coerceLines(r.keys) });
  }
  return out;
}

export async function generatePersonaDraft(userId: string, sessionId: string): Promise<PersonaDraft> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const seedText = session.persona_plan?.seed ?? "";
  const ctx = buildHostContextBlock(userId, session);
  const res = await weaverGenerateJsonWithUsage({
    userId,
    session,
    system: buildGenerateSystemPrompt(),
    user: buildGenerateUserMessage(seedText, ctx),
    temperature: 0.8,
  });

  const data = res.data;
  const rawSections = Array.isArray(data.sections) ? (data.sections as Record<string, unknown>[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of rawSections) {
    if (s && typeof s.id === "string") byId.set(s.id, s);
  }

  const sections: PersonaDraftSection[] = PERSONA_SECTIONS.map((def) => ({
    id: def.id,
    label: def.label,
    lines: coerceLines(byId.get(def.id)?.lines),
  }));

  const pronouns = (data.pronouns ?? {}) as Record<string, unknown>;
  return {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Persona",
    pronouns: {
      subjective: typeof pronouns.subjective === "string" ? pronouns.subjective.trim() : "they",
      objective: typeof pronouns.objective === "string" ? pronouns.objective.trim() : "them",
      possessive: typeof pronouns.possessive === "string" ? pronouns.possessive.trim() : "their",
    },
    sections,
    depth: coerceDepth(data.depth),
  };
}

function buildGreetingSystemPrompt(registerGuidance: string): string {
  return `You are the Weaver's greeting writer. Write ONE opening message from {{char}} to {{user}}, to be used as an alternate greeting on {{char}}'s card. {{user}} IS the specific persona described below — write the scene so it opens opposite that persona.

RELATIONSHIP STANCE: ${registerGuidance}

The message must sound like {{char}}'s own voice (the voice material is the source of truth). Reflect {{char}}'s stance toward {{user}} and let {{char}} act, not just react. Use {{user}} for the player-persona and {{char}} for the character where natural. Do NOT write {{user}}'s actions or words. Output only the greeting prose — no meta, no preamble, no headers.`;
}

function buildGreetingUserMessage(args: {
  charName: string;
  voice: string;
  scenario: string;
  firstMes: string;
  personaName: string;
  personaBody: string;
}): string {
  const parts: string[] = [];
  if (args.charName) parts.push(`CHARACTER: ${args.charName}`);
  if (args.voice) parts.push(`{{char}}'S VOICE:\n${args.voice.slice(0, 1000)}`);
  if (args.scenario) parts.push(`SCENARIO FRAME:\n${args.scenario.slice(0, 800)}`);
  if (args.firstMes) parts.push(`{{char}}'S DEFAULT OPENING (for voice reference — write a DIFFERENT opening):\n${args.firstMes.slice(0, 1000)}`);
  parts.push(`{{user}} IS THIS PERSONA — ${args.personaName}:\n${args.personaBody || "(a player persona)"}`);
  parts.push("Now write the opening greeting.");
  return parts.join("\n\n");
}

export async function generatePairedGreeting(
  userId: string,
  sessionId: string,
  draft: PersonaDraft,
  registerId: string,
): Promise<string> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const fields = getFields(userId, sessionId);
  const register = getPersonaRegister(registerId);
  const res = await weaverGenerateTextWithUsage({
    userId,
    session,
    system: buildGreetingSystemPrompt(register.guidance),
    user: buildGreetingUserMessage({
      charName: fieldText(fields, "name"),
      voice: fieldText(fields, "personality"),
      scenario: fieldText(fields, "scenario"),
      firstMes: fieldText(fields, "first_mes"),
      personaName: draft.name,
      personaBody: serializePersonaBody(draft.sections),
    }),
    temperature: 0.8,
  });
  return res.text;
}

export function commitPersona(userId: string, session: WeaverSession, draft: PersonaDraft): Persona {
  const name = (draft.name ?? "").trim() || "Persona";
  const body = serializePersonaBody(Array.isArray(draft.sections) ? draft.sections : []);
  const pronouns = draft.pronouns ?? { subjective: "they", objective: "them", possessive: "their" };

  let attachedWorldBookId: string | undefined;
  const depth = (Array.isArray(draft.depth) ? draft.depth : []).filter((d) => d.content.trim());
  if (depth.length > 0) {
    const book = createWorldBook(userId, {
      name: `${name} — persona depth`,
      description: `Triggered depth for the persona ${name}: detail that surfaces on relevance instead of riding every turn.`,
      metadata: { source: "weaver", weaver_session_id: session.id, persona_depth: true },
    });
    for (const entry of depth) {
      createEntry(userId, book.id, {
        key: entry.keys.length > 0 ? entry.keys : [entry.title],
        content: entry.content,
        comment: entry.title,
        selective: entry.keys.length > 0,
        constant: false,
      });
    }
    attachedWorldBookId = book.id;
  }

  return personasSvc.createPersona(userId, {
    name,
    description: body,
    subjective_pronoun: pronouns.subjective,
    objective_pronoun: pronouns.objective,
    possessive_pronoun: pronouns.possessive,
    attached_world_book_id: attachedWorldBookId,
    metadata: { source: "weaver", weaver_session_id: session.id },
  });
}
