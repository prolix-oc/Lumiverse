# Settings hydration provenance

Treat startup hydration, normalization, migration, compatibility repair, geometry synchronization, and state synchronization as automatic writes. They must not create local revision precedence before authoritative settings hydration completes.

Only explicit UI events, including clicks, direct control changes, and pointer-up drag/resize commits, may persist as user interactions during hydration. Preserve server merge protection for genuine concurrent edits.

When debugging a recurrence, inspect the write provenance at the actual event boundary and compare the load-start revision with the key revision. Do not fix the race by hardcoding defaults, removing newer-user merge protection, or delaying writes without identifying their origin.
