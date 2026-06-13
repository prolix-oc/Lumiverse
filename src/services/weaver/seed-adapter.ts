import { rawGenerate } from "../generate.service";
import { getConnection, getDefaultConnection } from "../connections.service";
import { isSlotId, slotParts, type SpineSlot } from "./slots";
import { getBuildRegistry } from "./build-registry";
import { buildExtractionPrompt, buildExtractionUserMessage } from "./prompts";
import type {
  WeaverSession,
  WeaverExtractedMaterial,
  WeaverCommittedFact,
  WeaverGap,
} from "../../types/weaver";

export interface SeedAdapter {
  type: string;
  sourceNoun: string;
  extract(userId: string, session: WeaverSession, signal?: AbortSignal): Promise<WeaverExtractedMaterial>;
}

function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

function coercePart(slots: readonly SpineSlot[], slot: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const v = value.trim();
  return slotParts(slots, slot).some((p) => p.id === v) ? v : undefined;
}

function coerceFacts(slots: readonly SpineSlot[], value: unknown): WeaverCommittedFact[] {
  if (!Array.isArray(value)) return [];
  const out: WeaverCommittedFact[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const slot = (raw as any).slot;
    const fact = (raw as any).fact;
    if (!isSlotId(slots, slot)) continue;
    if (typeof fact !== "string" || !fact.trim()) continue;
    const part = coercePart(slots, slot, (raw as any).part);
    out.push({ slot, ...(part ? { part } : {}), fact: fact.trim(), source: "extracted" });
  }
  return out;
}

function coerceGaps(slots: readonly SpineSlot[], value: unknown): WeaverGap[] {
  if (!Array.isArray(value)) return [];
  const out: WeaverGap[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const slot = (raw as any).slot;
    const note = (raw as any).note;
    if (!isSlotId(slots, slot)) continue;
    out.push({
      slot,
      note: typeof note === "string" ? note.trim() : "",
      source: "extracted",
    });
  }
  return out;
}

async function runExtraction(
  userId: string,
  session: WeaverSession,
  seedText: string,
  signal?: AbortSignal,
): Promise<{ committed_facts: WeaverCommittedFact[]; gaps: WeaverGap[] }> {
  const reg = getBuildRegistry(session.build_type);
  const conn = (session.connection_id ? getConnection(userId, session.connection_id) : null)
    ?? getDefaultConnection(userId);
  if (!conn) throw new Error("Weaver session has no connection configured");
  const model = session.model?.trim() || conn.model;
  if (!model) throw new Error("Weaver session has no model configured");

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model,
    connection_id: conn.id,
    messages: [
      { role: "system", content: buildExtractionPrompt(reg) },
      { role: "user", content: buildExtractionUserMessage(seedText) },
    ],
    parameters: { temperature: 0.4 },
    signal,
  });

  const content = stripCodeFence((response.content ?? "").trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Extraction returned invalid JSON");
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return {
    committed_facts: coerceFacts(reg.slots, obj.committed_facts),
    gaps: coerceGaps(reg.slots, obj.gaps),
  };
}

const dreamAdapter: SeedAdapter = {
  type: "dream",
  sourceNoun: "dream",
  async extract(userId, session, signal) {
    const seedText = session.seed.text.trim();
    if (!seedText) throw new Error("Seed is empty — nothing to read back");
    const { committed_facts, gaps } = await runExtraction(userId, session, seedText, signal);
    return {
      committed_facts,
      gaps,
      raw_source_text: seedText,
      provenance: { ...session.seed.provenance, seed_type: session.seed.type },
    };
  },
};

const npcAdapter: SeedAdapter = { ...dreamAdapter, type: "npc", sourceNoun: "dossier" };
const cardAdapter: SeedAdapter = { ...dreamAdapter, type: "card", sourceNoun: "imported card" };
const worldbookAdapter: SeedAdapter = { ...dreamAdapter, type: "worldbook", sourceNoun: "imported worldbook" };

const ADAPTERS: SeedAdapter[] = [dreamAdapter, npcAdapter, cardAdapter, worldbookAdapter];

export function getSeedAdapter(seedType: string): SeedAdapter {
  return ADAPTERS.find((a) => a.type === seedType) ?? dreamAdapter;
}

export function seedSourceNoun(seedType: string): string {
  return getSeedAdapter(seedType).sourceNoun;
}
