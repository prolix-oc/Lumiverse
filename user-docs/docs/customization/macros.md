# Macros

Macros are template variables written as `{{macro_name}}` that get replaced with dynamic content during prompt assembly. They can be used in preset blocks, world book entries, and other text fields.

**For the complete macro reference, see [Presets > Macros Reference](../presets/macros-reference.md).**

**For how macros are evaluated and execution order, see [Presets > Execution Order](../presets/execution-order.md).**

---

## Quick Examples

```
You are {{char}}, a character described as: {{description}}
You are speaking with {{user}}.
Current time: {{time}} on {{weekday}}.
```

During prompt assembly, each macro is replaced with its current value:

```
You are Aria, a character described as: A curious adventurer...
You are speaking with Alex.
Current time: 14:30 on Wednesday.
```

---

## Where Macros Work

- **Preset blocks** — The primary use case. Macros make your presets dynamic.
- **World book entries** — Note: entries are **not** macro-evaluated in Lumiverse (see [Execution Order](../presets/execution-order.md))
- **Guided generation** content
- **Author's Note** content
- **Chat messages** — Each message is macro-evaluated during assembly

---

## Common Categories

| Category | Examples | Full List |
|----------|----------|-----------|
| **Names** | `{{user}}`, `{{char}}`, `{{group}}` | [Identity macros](../presets/macros-reference.md#identity--names) |
| **Character data** | `{{description}}`, `{{personality}}`, `{{scenario}}` | [Character macros](../presets/macros-reference.md#character-data) |
| **Chat state** | `{{lastMessage}}`, `{{messageCount}}` | [Chat macros](../presets/macros-reference.md#chat--conversation) |
| **Random** | `{{random::1::100}}`, `{{pick::a::b::c}}`, `{{roll::2d6}}` | [Entropy macros](../presets/macros-reference.md#random--entropy) |
| **Variables** | `{{getvar::key}}`, `{{setvar::key::value}}` | [Variable macros](../presets/macros-reference.md#variables) |
| **Conditionals** | `{{if::condition}}...{{else}}...{{/if}}` | [Core macros](../presets/macros-reference.md#core-macros) |
| **Council & Lumia** | `{{lumiaCouncilDeliberation}}`, `{{loomStyle}}` | [Council macros](../presets/macros-reference.md#lumia--council) |

Lumiverse has **117 built-in macros** across 14 categories. See the [full reference](../presets/macros-reference.md) for the complete list.
