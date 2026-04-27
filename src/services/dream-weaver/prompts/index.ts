import { BASE_SYSTEM_FRAGMENT } from "./base-system";
import { ANTI_SLOP_FRAGMENT } from "./anti-slop";
import { FORMAT_APPEARANCE, FORMAT_LOREBOOK, FORMAT_NPC } from "./formats";
import { VOICE_RULES_FRAGMENT } from "./voice-rules";

export type PromptFragmentId =
  | "base-system"
  | "anti-slop"
  | "format:appearance"
  | "format:lorebook"
  | "format:npc"
  | "voice-rules";

const FRAGMENTS: Record<PromptFragmentId, string> = {
  "base-system": BASE_SYSTEM_FRAGMENT,
  "anti-slop": ANTI_SLOP_FRAGMENT,
  "format:appearance": FORMAT_APPEARANCE,
  "format:lorebook": FORMAT_LOREBOOK,
  "format:npc": FORMAT_NPC,
  "voice-rules": VOICE_RULES_FRAGMENT,
};

export function getFragment(id: PromptFragmentId): string {
  return FRAGMENTS[id];
}
