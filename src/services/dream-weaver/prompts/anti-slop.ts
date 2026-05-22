const BANNED_NAMES = [
  "Elara", "Alaric", "Kaelen", "Seraphina", "Thorne", "Lyra", "Zephyr",
  "Aria", "Cassian", "Rowan", "Ember", "Asher", "Luna", "Orion",
  "Raven", "Phoenix", "Sage", "Willow", "Jasper", "Ivy", "Silas",
  "Aurora", "Draven", "Celeste", "Kieran", "Nyx", "Soren", "Vesper",
  "Caspian", "Elowen", "Finnian", "Isolde", "Lucian", "Mira", "Rhys",
  "Astrid", "Dorian", "Freya", "Gideon", "Hazel", "Iris", "Jace",
  "Kira", "Leif", "Nova", "Ophelia", "Quinn", "Rune", "Stella",
];

export const ANTI_SLOP_FRAGMENT = `## Quality Standards

Before generating, ask yourself:
- Is this name something a real person would have, or does it sound like AI slop?
- Are these descriptions specific and grounded, or generic fantasy clichés?
- Does this personality show real behavioral patterns, or just vague traits?

Common AI slop patterns to avoid:
- Fantasy-mystical names that mean nothing: ${BANNED_NAMES.join(", ")}
- Overused descriptors: "orbs" for eyes, "cascade" for hair, "alabaster" skin
- Personality clichés: "cold exterior hiding warm heart", "mysterious past"
- Empty openings: weather descriptions with no character presence

Write like a skilled human author would: specific, grounded, with real behavioral texture.`;
