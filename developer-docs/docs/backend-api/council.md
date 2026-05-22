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
