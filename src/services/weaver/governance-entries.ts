import type { WeaverBibleSpine } from "../../types/weaver";

const GOVERNANCE_DEPTH = 4;

const DELIBERATION_CONTENT =
  "<weaver_deliberation>\nBefore writing {{char}}'s next reply, work through this silently, then write only the reply:\n- BEAT: what just changed in the scene.\n- LENS: how {{char}} specifically perceives it, through their own values and voice.\n- STATE: where {{char}} is emotionally and relationally right now.\n- BODY: what {{char}}'s embodiment allows or prevents here — consult for spatial sense, never narrate as a list.\n- BIND: the value-conflict in play.\n- CALIBRATION: how strongly this lands for {{char}}.\n\nBIND: when {{char}} faces a conflict between two things they value, keep them inside it. Make them pay the cost of their choice rather than reframing the moment into an easier one or splitting the difference to dodge the tension. The contradiction is the character; do not resolve it away to be agreeable.\n\nCALIBRATION: react in proportion to what genuinely fits {{char}}. Respond strongly only to what actually moves them, and stay flat or unbothered toward what does not. The neutral, unmoved reactions are as load-bearing as the intense ones — a character who reacts to everything equally reads as generic.\n</weaver_deliberation>";

const CRAFT_CONTENT =
  "<weaver_craft>\nNarrate in {{char}}'s own voice and lens, not a neutral camera: word choice, rhythm, and what gets noticed are all shaped by who {{char}} is. Keep dialogue in their idiolect.\n\nTreat physical and embodiment detail as a consult for spatial tracking, not material to recite — surface a detail only where the action makes it matter, never read appearance out like a spec sheet.\n\nDo not: use weather or a sigh as opening filler; restate {{user}}'s action back before responding; resolve tension quickly just to keep things comfortable; write {{user}}'s thoughts, words, or choices; flatten {{char}} into an accommodating version of themselves; or repeat an emotional beat in new words instead of advancing it.\n</weaver_craft>";

const AXIS_CONTENT =
  "<weaver_axis>\nIf {{char}} has a relational axis (a state variable such as trust, attachment, or corruption that moves across the chat), read its current level from the re-anchor's Now line and the recent scene. Only the declared band-deltas shift with it; {{char}}'s hard limits never move at any level. Move the level gradually, in the direction the interaction earns, and let {{char}}'s mode and voice reflect the current level rather than jumping to an endpoint. If {{char}} has no such axis, ignore this.\n</weaver_axis>";

function governanceEntry(
  comment: string,
  content: string,
  insertionOrder: number,
): Record<string, unknown> {
  return {
    keys: [],
    content,
    comment,
    constant: true,
    enabled: true,
    insertion_order: insertionOrder,
    position: "at_depth",
    depth: GOVERNANCE_DEPTH,
    role: "system",
    case_sensitive: false,
  };
}

function hasRelationalAxis(spine: WeaverBibleSpine): boolean {
  return Boolean(spine.entries.find((e) => e.slot === "relational_axis")?.content.trim());
}

export function buildGovernanceEntries(spine: WeaverBibleSpine): Array<Record<string, unknown>> {
  const entries = [
    governanceEntry("Weaver governance · deliberation & bind", DELIBERATION_CONTENT, 1),
    governanceEntry("Weaver governance · voice & anti-patterns", CRAFT_CONTENT, 2),
  ];

  if (hasRelationalAxis(spine)) {
    entries.push(governanceEntry("Weaver governance · relational axis", AXIS_CONTENT, 3));
  }

  return entries;
}
