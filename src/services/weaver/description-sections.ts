export interface DescriptionSection {
  tag: string;
  sourceSlots: string[];
  requiresSlot?: string;
  includeWhen?: string;
  format: string;
}

export const DESCRIPTION_SECTIONS: readonly DescriptionSection[] = [
  {
    tag: "CORE",
    sourceSlots: ["archetype", "values", "central_contradiction"],
    format:
      "Lead with `{Name} — {one-line essence}.` Then these labeled lines, each on its own:\n" +
      "  • `Essence:` the single engine that drives them, in one line.\n" +
      "  • `Silhouette:` how they read at a glance — build, the way they move, and the one specific visual signature that fixes them — not a full physical description.\n" +
      "  • `OCEAN:` the five-trait read as compact codes `O##/C##/E##/A##/N##` (0–100). Include this line only if the Bible carries a psychometric read; otherwise omit it.\n" +
      "  • `Values:` the ranked values as `1) {value} → {the concrete behavior that proves it}; 2) …; 3) …`. Every value is paired, via `→`, with a specific act that demonstrates it. Keep CORE compact and re-injectable.",
  },
  {
    tag: "ARC",
    sourceSlots: ["experiences", "values"],
    format:
      "3–5 formative beats in chronological past tense. Each beat: `{age or time}, {what happened}, {a sensory anchor} → {what it taught them}.` followed by two inline annotations: `*forged {the value or trait this beat created}* *justifies {the self-justification it now licenses}*`. The `*forged …*` / `*justifies …*` annotations are required on every beat — they trace each value back to the moment that made it and forward to the distortion it now excuses.",
  },
  {
    tag: "FORM",
    sourceSlots: ["form", "abilities"],
    format:
      "Prefix the section literally with `(consult for spatial tracking — never narrated)`. This is a reference sheet, not prose — state details plainly, never rhapsodize. Then:\n" +
      "  • Lead line: `tier: {human…xeno} · {height} · {weight} · {build}` and, where the body makes them relevant, proportions (`bust / underbust / band / waist / hip`) with any derived value in parentheses (e.g. `(→ ~D)`). Keep proportions internally consistent and realistic for the build.\n" +
      "  • `Forward:` the few visible details that actually matter at a glance — coloring, hair, eyes, marks, adornment.\n" +
      "  • `Distinguishing:` the idiosyncratic tells (a specific smile, a footwear habit, how they carry tension).\n" +
      "  • `Capability:` what this body lets them do or prevents — the load-bearing part, the reason FORM exists.\n" +
      "  • `Presence:` scent, voice timbre, and proxemics (how they hold or close distance).",
  },
  {
    tag: "TENSIONS",
    sourceSlots: ["tensions", "central_contradiction"],
    format:
      "First the behavioral signatures as `IF {trigger} THEN {response}.` lines — one per line, drawn from the Bible's tensions. Then a `Conflicts:` line stating the central contradiction as opposed pulls: `{X} vs {Y} ({the bind in a few words})`.",
  },
  {
    tag: "INTENT",
    sourceSlots: ["intents"],
    format:
      "Three labeled lines: `Super-objective:` the lifelong want that drives them; `Obstacle:` what blocks it (usually an internal pattern, not an external barrier); `Strategy:` how they actually pursue it, turn to turn.",
  },
  {
    tag: "NEGATIVE SPACE",
    sourceSlots: ["negative_space"],
    format:
      "A few terse lines on what they will NOT say or do, how they deflect when pressed, and the specific tell that shows when they are cornered. This is the shape of what they avoid — keep it concrete and behavioral, not a feelings summary.",
  },
  {
    tag: "GRADIENT",
    sourceSlots: ["gradient"],
    format:
      "Optionally lead with `(attachment: {style})` when the Bible establishes an attachment style. Then the four bands plus the gate, each labeled:\n" +
      "  • `WON'T:` what no amount of closeness unlocks.\n" +
      "  • `NEUTRAL:` the flat band — what genuinely leaves them unmoved. This is load-bearing; keep it concrete and varied (a character who reacts to everything reads as generic).\n" +
      "  • `WILL:` what they engage with once trust is earned.\n" +
      "  • `CRAVES:` each craving paired with the aversion it answers, as `{craving} (vs. {aversion})`.\n" +
      "  • `TRUST GATE:` the single observable act that signals they actually trust someone.",
  },
  {
    tag: "AXIS",
    sourceSlots: ["relational_axis"],
    requiresSlot: "relational_axis",
    includeWhen: "the Bible carries a relational arc (a state that changes as the bond deepens)",
    format:
      "Lead with `(axis: {name}, {low pole} → {high pole})`. Then state the band-deltas: how the character's mode, voice, and openness differ at LOW vs HIGH on the axis, and state plainly that hard limits never move at any level. Only the declared deltas shift.",
  },
  {
    tag: "INTIMACY",
    sourceSlots: ["intimacy"],
    requiresSlot: "intimacy",
    includeWhen: "the Bible carries intimacy material",
    format:
      "Structural and non-explicit only: what they are drawn to, what they refuse, where the lines are, and how desire shows up in their behavior. Describe the shape of it — never graphic content.",
  },
];

export function buildDescriptionBundleGuidance(): string {
  const order = DESCRIPTION_SECTIONS.map((s) => `[${s.tag}]`).join(", ");

  const sections = DESCRIPTION_SECTIONS.map((s) => {
    const head = s.includeWhen
      ? `[${s.tag}] — include ONLY if ${s.includeWhen}; omit the whole section otherwise.`
      : `[${s.tag}]`;
    return `${head}\n${s.format}`;
  }).join("\n\n");

  return (
    "Write the description as a single TAGGED BUNDLE: bracket-tagged sections, load-bearing first, in this exact order — " +
    `${order}. Use the literal bracket tags as section headers. Every section is drawn faithfully from the matching Bible ` +
    "material and never softened toward the generic; follow each section's format exactly. Conditional sections appear only " +
    "when the Bible carries their material. No preamble, no closing summary, no meta.\n\n" +
    sections
  );
}
