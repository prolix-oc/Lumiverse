# Council

**Permission Required:** None (Free tier)

The `spindle.council` namespace provides read-only access to the user's active Council configuration, their currently assigned Council Members, and all Lumia items available for use on the council.

This allows your extension to understand the narrative directors active in the chat, adjust tool outputs to match specific assigned personas, or retrieve details about the broader pack ecosystem the user has installed.

## API Reference

### `getSettings`

Retrieve the full Council settings for a user, including tool execution modes, sidecar context window settings, and member assignments.

```ts
// Get settings for the current user
const settings = await spindle.council.getSettings();

// In operator mode, you can specify a userId
const userSettings = await spindle.council.getSettings({ userId: "user-uuid" });
```

### `getMembers`

Retrieve the full context of the user's currently assigned Council Members.

This returns an array of `CouncilMemberContext` objects, which merge the user's role and probability assignments (`CouncilMember`) with the underlying Lumia item's full definition (personality, physical description, behavior, and avatar URL).

This is particularly useful when you need to tailor an extension's narrative behavior to the active directors.

```ts
const activeMembers = await spindle.council.getMembers();

for (const member of activeMembers) {
  console.log(`Member: ${member.name}`);
  console.log(`Role: ${member.role}`);
  console.log(`Chance to participate: ${member.chance}%`);
  console.log(`Personality: ${member.personality}`);
  console.log(`Avatar URL: ${member.avatarUrl}`);
}
```

**Note:** If your extension provides a Council tool via `spindle.registerTool`, the active `CouncilMemberContext` is automatically delivered to your `TOOL_INVOCATION` handler as `payload.councilMember`. You only need to call `getMembers()` if you need to inspect the *entire* council outside of a tool execution cycle.

### `getAvailableLumiaItems`

Retrieve all Lumia items available to the user across all of their installed packs. This represents the total pool of characters/entities that could be assigned to the Council.

```ts
const allItems = await spindle.council.getAvailableLumiaItems();

console.log(`The user has ${allItems.length} total Lumia items available.`);

for (const item of allItems) {
  console.log(`- ${item.name} (from pack: ${item.pack_id})`);
}
```

## Type Definitions

Refer to the `lumiverse-spindle-types` package for complete type structures.

### `CouncilSettings`
Contains the overarching council configuration.
```ts
interface CouncilSettings {
  councilMode: boolean;
  members: CouncilMember[];
  toolsSettings: CouncilToolsSettings;
}
```

### `CouncilMemberContext`
A rich snapshot combining a member's council assignment with their source Lumia traits.
```ts
interface CouncilMemberContext {
  memberId: string;
  itemId: string;
  packId: string;
  packName: string;
  name: string;
  role: string;
  chance: number;
  avatarUrl: string | null;
  definition: string;
  personality: string;
  behavior: string;
  genderIdentity: 0 | 1 | 2 | 3; // 0=feminine, 1=masculine, 2=neutral, 3=any
}
```

### `LumiaItemDTO`
The full data transfer object for a single Lumia item definition.
```ts
interface LumiaItemDTO {
  id: string;
  pack_id: string;
  name: string;
  avatar_url: string | null;
  author_name: string;
  definition: string;
  personality: string;
  behavior: string;
  gender_identity: 0 | 1 | 2 | 3;
  version: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}
```

---

## WORK Engine advisory boundaries

The extension `spindle.council` API above remains a read-only
Response/direct-surface API. It is not the Council capability used by the
WORK Engine, and it does not expose that capability's admission, transcript,
usage, or receipt data.

WORK Council has no public REST route or public WORK tool DTO. At Agentic
admission the host resolves the reviewed LLM-only Council definitions, member
grants, sidecar connection, requiredness, and correlation. Ambient Response
tools/events, MCP and extension tools, host tools, delegation, WORK tools,
workspace/direct writes, publication, and commit authority are denied. The
sidecar is advisory input to the root WORK frame only: it cannot add tools,
spawn children, widen the frozen target, or write the canonical Response.

An optional Council result with non-empty deliberation is `accepted`. An
optional unavailable, empty, failed, or cancelled result is `omitted` and
does not block the turn; the owner inspection projection records the omission.
A required non-accepted result fails the WORK operation as
`council_required_failed`. The public error remains the factual underlying
failure category; clients must use the public error's recovery fields rather
than infer a recovery action from the Council receipt.

The private owner-inspection receipt is the closed `AgentCouncilReceiptV1`
shape:

```ts
{
  version: 1,
  id: string,
  requestId: string,
  checkpoint: 'WORK',
  required: boolean,
  startedAt: number,
  completedAt: number | null,
  state: 'accepted' | 'omitted' | 'failed' | 'cancelled',
  memberCount: number,
  resultDigest: string | null,
  correlation: AgentInspectionCorrelationV1,
  reason: AgentInspectionReasonV1 | null,
  canonical: false,
}
```

`correlation` is the closed owner-inspection object, not an opaque string. It
contains `turnSessionId`, `runId`, `attemptId`, `chatId`, `generationId`,
nullable `messageId`, `swipeId`, `actorId`, and `recipientId`, plus
`phase`, nullable `taskId`, `toolId`, and `parentId`,
`hostCorrelationId`, and `hostSequence`. `reason` is the closed
`AgentInspectionReasonV1` union or `null`.

The Council transcript, prompt inspection, usage evidence, and omission
details are owner-inspection data. They are not Response content or a public
compatibility event.

### Cortex sidecar

Cortex likewise has no public route or generic WORK tool DTO. The host creates
an authorized immutable snapshot before the WORK read:

```ts
{
  ownerId: string,
  attemptId: string,
  chatId: string,
  targetMessageId: string | null,
  targetSwipeId: number | null,
  checkpoint: 'WORK',
  snapshotId: string,
  revision: string | number,
  value: unknown,
  availability?: unknown,
}
```

A read returns either `{ kind: 'accepted', value, receipt }` or, for an
optional unavailable entry, `{ kind: 'omission', omission, receipt }`. A
required sidecar failure throws the Cortex sidecar error and fails WORK; it
does not become an optional omission.

`AgentCortexReceiptV1` is private owner-inspection evidence. It records the
request and attempt, `checkpoint: 'WORK'`, snapshot/source revisions and
target scope, requiredness, timing, state
(`accepted | omitted | failed | cancelled`), result digest/count,
correlation, reason, omission, and `canonical: false`. Cortex provides no
tools, children, workspace/publication writes, or commit authority. Root-only
context is stripped before RENDER, and the private receipt is never placed in
the final Response.
