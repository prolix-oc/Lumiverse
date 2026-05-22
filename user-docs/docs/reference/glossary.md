# Glossary

Key terms used throughout Lumiverse and these guides.

---

## A

**Alternate Fields**
: Variant versions of a character's description, personality, or scenario that can be selected per-chat.

**Alternate Greetings**
: Multiple first-message options for a character. Chosen when starting a new chat.

**API Key**
: A secret credential from an AI provider that authenticates your requests. Stored encrypted in Lumiverse.

**Assembly**
: The process of building the complete prompt from preset blocks, character data, world info, macros, and chat history.

**Author's Note**
: A hidden instruction injected at a specific depth in the conversation to influence the AI's behavior.

## B

**Block (Prompt Block)**
: A section of text in a preset that contributes to the assembled prompt. Blocks have roles, positions, and can be enabled/disabled.

**Branch**
: A fork of a conversation at a specific message, creating a new chat with shared history up to that point.

## C

**Character Card**
: A standardized format (CCSv1/v2/v3) for packaging character data, optionally embedded in a PNG image.

**CHARX**
: A ZIP archive format for character cards that can include the card JSON, avatar, expressions, and Lumiverse modules.

**Connection**
: A saved configuration linking Lumiverse to an AI provider (includes provider, model, API key, and URL).

**Constant Entry**
: A world book entry that is always included in the prompt regardless of keyword matching.

**Context Window**
: The maximum number of tokens a model can process at once (prompt + response combined).

**Cortex (Memory Cortex)**
: Lumiverse's narrative-aware memory layer that tracks entities, relationships, salience, and arcs on top of basic long-term memory. See [Memory Cortex](../chatting/memory-cortex.md).

**Council**
: A multi-persona deliberation system where AI personas analyze the scene and provide guidance before the main generation.

## D

**Databank**
: A knowledge bank of uploaded documents that can be RAG-retrieved during generation. Documents are referenced with `#slug` mentions in chat. See [Databank](../chatting/databank.md).

**Depth**
: How many messages from the end of the chat to insert content. Lower depth = closer to the end = more influence.

**Dry Run**
: A test that assembles the full prompt without actually calling the AI. Shows exactly what the model would see.

## E

**Embedding**
: A numeric vector that represents the *meaning* of a piece of text. Powers semantic world-book activation, long-term memory, databank retrieval, and the cortex. See [Embeddings](../settings/embeddings.md).

**Entity**
: A named thing tracked by the Memory Cortex — character, location, faction, item, concept, or event. Accumulates facts, relationships, and salience over time.

**Expression**
: An emotion-mapped image that changes dynamically based on the conversation mood.

## G

**Generation**
: The process of sending a prompt to the AI and receiving a response. Types: normal, regenerate, continue, swipe, impersonate, quiet.

**Global Add-On**
: A persona add-on stored in a shared library, attachable to any number of personas. Edits propagate everywhere it's attached.

**Group Chat**
: A conversation with multiple AI characters who take turns responding and interact with each other.

## I

**Interlink**
: A live, bidirectional link between two chats' Memory Cortex state. Each chat sees the other's entities and relationships in real time.

## L

**Loom**
: Content blocks from packs, categorized as narrative styles, utilities, or retrofits.

**Lorebook**
: Another name for World Book — a collection of keyword-triggered contextual entries.

**Lumia**
: An AI persona from a pack, used as a council member or for narrative style selection.

## M

**Macro**
: A template variable (e.g., `{{char}}`) that gets replaced with dynamic content during prompt assembly. See [Macros Reference](../presets/macros-reference.md).

## O

**Operator Panel**
: Settings panel for instance-level operations — check for updates, switch git branches, restart the server. Requires the runner to be attached.

**Outlet**
: A named content slot a world book entry can export — referenced from presets and other entries via `{{outlet::name}}`.

## P

**Pack**
: A content bundle containing Lumia items, Loom items, and/or Loom tools.

**Persona**
: Your identity in conversations — includes name, pronouns, description, avatar, and optional add-ons.

**Persona Add-On**
: An optional, toggleable block of content attached to a persona. Lets you extend your persona description dynamically without editing it.

**Preset**
: A saved configuration defining prompt block order, sampler settings, and completion behavior.

**Preset Profile**
: A snapshot of block enabled/disabled states, bindable to default, character, or chat contexts.

**Provider**
: An AI service (OpenAI, Anthropic, Google, etc.) that Lumiverse connects to for generation.

## R

**Recursion (World Info)**
: When activated world book entries contain keywords that trigger additional entries.

**Regex Script**
: A text transformation rule using regular expressions, applied at various stages of the pipeline.

**Runner**
: The supervisor process that the start scripts attach. Performs updates, branch switches, and restarts on behalf of the Operator Panel. Disable with `--no-runner` if you don't want it.

## S

**Salience**
: A score (0.0–1.0) the Memory Cortex assigns to each memory chunk based on emotional weight, narrative flags, and information density. High-salience memories resist decay.

**Sampler Settings**
: Parameters that control how the AI generates text (temperature, top-p, penalties, etc.).

**Scan Depth**
: How many recent messages are checked for world book keywords.

**Selective Logic**
: Secondary keyword conditions (AND, OR, NOT) that refine when a world book entry activates.

**Sidecar**
: A secondary, usually lighter LLM used for background tasks — Memory Cortex extraction, council tools, expression detection, heuristic arbitration.

**Sovereign Hand**
: A Loom co-pilot mode that lets you steer the next generation with directorial instructions while the AI keeps narrating.

**Spindle**
: Lumiverse's extension system. Extensions run in an isolated Bun Worker with a permission-gated RPC bridge. See [Extensions](../extensions/index.md).

**Spindle Capability**
: A manifest declaration that bypasses install-time code-pattern scans for legitimate uses of patterns like `eval` or base64 decode. Distinct from runtime permissions.

**Spindle Permission**
: A runtime grant that lets an extension access a specific subsystem (chats, generation, cors_proxy, etc.). Privileged permissions require admin approval.

**Sticky Entry**
: A world book entry that stays active for a set number of turns after its keywords stop appearing.

**Swipe**
: An alternate version of a message. Generated by regenerating a response, creating a deck of alternatives.

## T

**TagLibrary**
: A SillyTavern extension that stores character tags separately from the card. Lumiverse's migration wizard can re-apply TagLibrary backups after a regular SillyTavern import.

**Theme Pack**
: A shareable bundle containing theme variables, custom CSS, component overrides, and uploaded theme assets. Exported and imported from the Custom CSS modal.

**Token**
: The basic unit of text for AI models. Roughly 3/4 of a word. Used to measure context size and response length.

## V

**Vault**
: A frozen snapshot of a chat's Memory Cortex state (chunks, entities, relationships) packaged as a reusable, read-only knowledge object. Attach it to other chats so they "remember" the source chat.

## W

**World Book**
: A collection of entries that inject contextual information into the prompt when their keywords appear in the conversation. Also called a lorebook.

**World Info**
: Another name for World Book content and the system that activates it.
