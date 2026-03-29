# Sampler Settings

Sampler settings control *how* the AI generates text — the randomness, creativity, length, and repetition tendencies of its output.

---

## Core Parameters

### Temperature

Controls randomness. Lower values make the AI more predictable and focused; higher values make it more creative and varied.

| Value | Behavior |
|-------|----------|
| **0.1 - 0.3** | Very focused, deterministic — good for factual or precise output |
| **0.5 - 0.7** | Balanced — clear and coherent with some variety |
| **0.8 - 1.0** | Creative — more varied word choices and unexpected turns |
| **1.2 - 1.5** | Very creative — can get chaotic |
| **> 1.5** | Highly random — output may become incoherent |

### Max Tokens

The maximum number of tokens the AI will generate in one response. Set this based on your preferred response length:

- **150-300** — Short, snappy responses
- **400-800** — Medium-length responses (common for RP)
- **1000-2000** — Long, detailed responses
- **4000+** — Very long form (novel-style passages)

!!! warning "Reasoning models and max tokens"
    Models with **native reasoning** (chain-of-thought) — such as DeepSeek R1, Claude with extended thinking, or OpenAI o-series — use tokens for their internal reasoning process *in addition to* the visible response. If your max tokens is too low, the model may exhaust its budget on reasoning and produce a truncated or empty reply. Give reasoning models a generous max tokens allowance (2000+ minimum, higher for complex prompts).

!!! note "Token counting"
    Lumiverse calculates token counts using the tokenizer that matches your provider and model. If no exact tokenizer is available, it falls back to an estimation. The token count shown in the UI and dry run reflects this.

### Top-P (Nucleus Sampling)

Limits the AI to choosing from the most probable tokens that make up a cumulative probability of P. Lower values = more focused.

- **0.9 - 1.0** — Almost no restriction (default)
- **0.7 - 0.8** — Moderate restriction
- **0.3 - 0.5** — Strong restriction — very predictable output

### Top-K

Limits the AI to choosing from the top K most probable tokens. Works alongside Top-P.

- **0** — Disabled (default for many providers)
- **10-40** — Moderate restriction
- **1** — Always picks the most likely token (completely deterministic)

### Min-P

Removes tokens whose probability is below a minimum threshold relative to the top token. Often used as an alternative to Top-P.

- **0** — Disabled
- **0.05 - 0.1** — Light filtering (recommended starting point)

---

## Repetition Control

!!! warning "Limited provider support"
    Most major providers (Anthropic, Google, DeepSeek, and many others) **do not support** frequency, presence, or repetition penalties. These parameters are silently ignored if the provider doesn't implement them. They primarily work with OpenAI and OpenAI-compatible APIs. Only use these if you know your provider supports them.

### Frequency Penalty

Penalizes tokens based on how often they've appeared in the text so far. Higher values reduce word repetition.

- **0** — No penalty (default)
- **0.1 - 0.5** — Mild reduction in repetition
- **0.5 - 1.0** — Strong reduction

### Presence Penalty

Penalizes tokens that have appeared *at all*, regardless of frequency. Encourages the AI to explore new topics.

- **0** — No penalty (default)
- **0.1 - 0.5** — Encourages variety
- **0.5 - 1.0** — Strongly discourages revisiting topics

### Repetition Penalty

A multiplier penalty on repeated tokens. Some providers use this instead of frequency/presence penalties.

- **1.0** — No penalty
- **1.05 - 1.15** — Mild to moderate penalty

!!! warning "Don't stack penalties"
    Using both frequency penalty and repetition penalty at the same time can make the AI avoid common words entirely, leading to awkward prose. Pick one approach — and only if your provider supports it.

---

## Context Settings

### Context Size

The maximum number of tokens for the entire conversation context (prompt + history). This should match your model's context window:

- **128,000** — Standard for most current models (GPT-5.x, DeepSeek, etc.)
- **200,000** — Claude Opus 4.5, Claude Sonnet 4.5, and older Claude models
- **1,000,000** — Claude Opus 4.6, Claude Sonnet 4.6, Gemini Pro, Gemini Flash, and other extended context models
- **32,768 or less** — Some smaller or older models

Most models you'll encounter in 2026 support at least 128K context. Check your provider's model page if unsure.

### Seed

A fixed seed for reproducible output. When set, the same prompt produces the same response. Useful for testing. Set to `0` or leave blank for random.

---

## Custom Stop Strings

Strings that cause the AI to stop generating when encountered. Common uses:

- Stop at `\n\n` to prevent runaway generation
- Stop at character name prefixes to prevent the AI from writing as your character

---

## Sampler Overrides

The preset can define **sampler overrides** — parameter values that override the connection's defaults. Each override can be individually enabled or disabled, giving you granular control over which parameters the preset controls and which come from the connection.

---

## Tips

!!! tip "Start with temperature"
    Temperature is the single most impactful setting. Start there and adjust other parameters only if you need finer control.

!!! tip "Use the dry run"
    The dry run shows you the final parameter values after all overrides are applied. Useful for verifying your settings are taking effect.
