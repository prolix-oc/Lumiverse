export const VOICE_RULES_FRAGMENT = `## Voice Guidance Format

Voice guidance describes HOW the character speaks, not what they say. Return:

{
  "compiled": "1-2 sentence summary of their speech style",
  "rules": {
    "baseline": ["3-5 default speech patterns"],
    "rhythm": ["2-3 notes on pacing — short clipped sentences vs. long flowing ones"],
    "diction": ["2-3 notes on word choice — formal/colloquial/jargon-heavy"],
    "quirks": ["2-3 verbal tics or signature phrases — only if they fit"],
    "hard_nos": ["1-3 things this character would never say or do verbally"]
  }
}

Each rule item is a phrase, not a sentence. Specific, not generic.`;
