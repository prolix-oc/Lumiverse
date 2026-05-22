# Preset Profiles

Preset profiles let you save and restore a **preset selection plus its block enabled/disabled states**. You can bind these snapshots to specific characters or chats so Lumiverse switches to the right preset and block configuration automatically.

---

## The Problem Profiles Solve

Imagine you have a preset with 15 blocks. For one character, you want blocks 1-10 enabled. For another, you want blocks 3, 7, and 11-15 enabled. Without profiles, you'd have to manually toggle blocks every time you switch characters.

Profiles automate this. Each profile remembers which preset to use and the on/off state of every block inside it, then restores both when you switch context.

---

## Profile Types

### Default Profile

A baseline snapshot for one specific preset. Think of it as that preset's "general purpose" block configuration.

### Character Profile

A preset + block snapshot bound to a specific character. When you open a chat with that character, Lumiverse switches to that preset and restores its block states automatically.

### Chat Profile

A preset + block snapshot bound to a specific chat. This is the most specific level — it overrides both the default and character profiles.

---

## Resolution Order

When assembling a prompt, Lumiverse resolves the active profile in this order:

1. **Chat profile** — If the current chat has a profile, use it
2. **Character profile** — Otherwise, if the character has a profile, use it
3. **Default profile** — Otherwise, use the default profile
4. **Raw preset states** — If no profiles exist at all, use the block states as they are in the preset

Chat and character profiles are authoritative: they choose the preset first, then apply that profile's block states. Defaults are stored per preset, so the default profile only applies to the currently selected preset.

---

## Creating a Profile

1. Configure your blocks the way you want them (enable/disable as needed)
2. Click **Capture Profile** (or the equivalent in the Loom Builder)
3. Choose what to save as:
    - **Default** — The baseline snapshot for the current preset
    - **Character** — Bound to the current character
    - **Chat** — Bound to the current chat

The snapshot records the current preset and the enabled/disabled state of every block.

---

## Use Cases

- **Character-specific prompts** — A fantasy character uses narrative blocks; a modern character uses casual blocks
- **Per-chat tuning** — One chat emphasizes action scenes (action blocks on); another emphasizes dialogue (dialogue blocks on)
- **Quick switching** — Swap between "detailed" and "concise" block configurations without manual toggling
