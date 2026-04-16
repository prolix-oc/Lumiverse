# Group Chats

Group chats let you have conversations with **multiple AI characters at once**. Characters interact with you and with each other, creating dynamic multi-character scenes.

---

## Creating a Group Chat

1. Open the **Character Browser** panel
2. Select multiple characters (use the group chat button or multi-select mode)
3. Click **Create Group Chat**
4. Each character's greeting message appears in sequence

Alternatively, you can add characters to an existing group chat later.

---

## How Group Chats Work

In a group chat, characters take turns responding. After you send a message:

- The AI generates a response as one of the characters
- The "focused" character is typically auto-selected, but you can choose who responds next
- Each character has their own personality, description, and expression set

Characters are aware of each other — they can address one another by name and react to what others have said.

---

## Adding & Removing Members

### Adding a Member

1. Open the chat
2. Use the group member bar or settings to **Add Member**
3. Select a character
4. Choose whether to include their greeting message

When a new member joins, you can optionally inject their first message into the conversation as an introduction.

### Removing a Member

1. Open the group member bar
2. Click **Remove** on the character you want to remove

A group chat must always have at least 2 characters. If you remove a member that was the chat's "primary" character, the first remaining member takes over that role.

---

## Muting Characters

Sometimes you want a character present in the scene but not actively speaking. **Muting** a character:

- Excludes them from auto-target selection (they won't be chosen to respond automatically)
- Removes them from the `{{groupNotMuted}}` macro
- Keeps them in the chat — they can still be manually targeted

To mute or unmute, use the member controls in the group chat bar.

---

## Targeting a Specific Character

In group chats, you can specify which character should respond next:

- The AI auto-selects based on context by default
- You can override this by clicking a character's name in the group member bar before generating
- The `{{charGroupFocused}}` macro resolves to the currently targeted character

---

## Group Chat Macros

These macros are especially useful in group chat presets:

| Macro | Resolves To |
|-------|-------------|
| `{{group}}` | Comma-separated list of all character names |
| `{{groupNotMuted}}` | Names of non-muted characters |
| `{{groupOthers}}` | Names of characters other than the focused one |
| `{{groupMemberCount}}` | Number of characters in the group |
| `{{groupLastSpeaker}}` | Name of the character who spoke last |
| `{{isGroupChat}}` | "yes" or "no" |
| `{{charGroupFocused}}` | The currently targeted character's name |

---

## Tips for Good Group Chats

!!! tip "Keep groups small"
    2-4 characters work best. With more than 5, conversations can become chaotic and harder for the AI to track.

!!! tip "Give characters distinct voices"
    Make sure each character has a clearly different personality, speech pattern, or perspective. This helps the AI distinguish between them.

!!! tip "Use muting strategically"
    Mute characters who are "in the room" but not central to the current scene. Unmute them when it's their time to contribute.
