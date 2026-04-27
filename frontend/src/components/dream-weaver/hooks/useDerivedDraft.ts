import { useMemo } from "react";
import type { DreamWeaverMessage } from "@/api/dream-weaver-tooling";

interface DraftV2 {
  name: string | null;
  appearance: string | null;
  appearance_data: Record<string, unknown> | null;
  personality: string | null;
  scenario: string | null;
  first_mes: string | null;
  greeting: string | null;
  voice_guidance: any;
  lorebooks: Array<{ key: string[]; comment: string; content: string }>;
  npcs: Array<{ name: string; description: string; voice_notes?: string }>;
}

const EMPTY: DraftV2 = {
  name: null, appearance: null, appearance_data: null, personality: null,
  scenario: null, first_mes: null, greeting: null, voice_guidance: null,
  lorebooks: [], npcs: [],
};

const APPLY: Record<string, (d: DraftV2, output: any) => DraftV2> = {
  set_name: (d, o) => ({ ...d, name: o.name }),
  set_appearance: (d, o) => ({ ...d, appearance: o.appearance, appearance_data: o.appearance_data }),
  set_personality: (d, o) => ({ ...d, personality: o.personality }),
  set_scenario: (d, o) => ({ ...d, scenario: o.scenario }),
  set_voice_guidance: (d, o) => ({ ...d, voice_guidance: o.voice_guidance }),
  set_first_message: (d, o) => ({ ...d, first_mes: o.first_mes }),
  set_greeting: (d, o) => ({ ...d, greeting: o.greeting }),
  add_lorebook_entry: (d, o) => ({ ...d, lorebooks: [...d.lorebooks, o] }),
  add_npc: (d, o) => ({ ...d, npcs: [...d.npcs, o] }),
};

export function useDerivedDraft(messages: DreamWeaverMessage[]): DraftV2 {
  return useMemo(() => {
    let draft: DraftV2 = { ...EMPTY, lorebooks: [], npcs: [] };
    for (const m of messages) {
      if (m.kind !== "tool_card" || m.status !== "accepted") continue;
      const apply = APPLY[m.tool_name ?? ""];
      const payload = m.payload as { output: any };
      if (!apply || !payload.output) continue;
      draft = apply(draft, payload.output);
    }
    return draft;
  }, [messages]);
}
