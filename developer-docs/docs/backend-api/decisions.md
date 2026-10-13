# Decision models

`spindle.decisions` evaluates named questions against text or JSON using the user's saved Decision connections. Built-in providers are OpenRouter and TypeSafe. Declare the `decisions` permission in `spindle.json` and obtain the user's grant. The host advertises `decisions-v1: 1` in `spindle.host.capabilities`; check this before calling the API on older hosts.

Use `lumiverse-spindle-types` version **0.6.45** or newer for `SpindleDecisionsAPI`, the `Decision*` types, and the `decisions` permission.

## Evaluate

```ts
const result = await spindle.decisions.evaluate({
  state: { latestMessage: 'Let us move to the next morning.' },
  questions: {
    handling: {
      type: 'choice',
      instructions: 'Which handling path fits this message?',
      criteria: {
        continue: 'Continue the current scene.',
        transition: 'Move to another scene.',
      },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is the request?',
      criteria: ['Routine', 'Urgent', 'Immediate'],
    },
    sceneChange: {
      type: 'noul',
      instructions: 'Does this request a scene change?',
    },
  },
}, { signal: controller.signal })

// Inferred as 'continue' | 'transition'.
const path = result.answers.handling.choice
const confidence = result.answers.handling.confidence
const urgency = result.answers.urgency.score
const sceneChangeProbability = result.answers.sceneChange.noul
```

`connection_id` selects a saved connection; omitting it selects the user's default Decision connection. An invalid explicit ID fails rather than selecting another profile. `model` optionally overrides the connection's saved model for one request. Extensions never supply credentials or endpoints. User extensions always resolve their owner's account. Operator extensions must supply `userId`.

Requests contain 1–256 named questions. Choice criteria contain 2–255 options; descriptions may be `null`. Score criteria contain 2–10 ordered descriptions. Noul criteria are optional; when supplied, they contain both `true` and `false` descriptions. State, instructions, and descriptions support text, JSON objects, and arrays. Input is limited to 1 MiB and JSON depth 32. This release supports text/JSON evaluation; it does not manage image or audio uploads.

Answers retain native probabilities, confidence, fractional scores, and Score legends. Noul is a probability from 0 to 1. Confidence and the chosen option's probability are separate values. Invalid or incomplete provider answers fail the request. The result includes the resolved `model`, `answers`, and optional `usage`, request `id`, and serving `provider`. Missing usage is left absent; nullable usage values are preserved.

Evaluations have a 30-second deadline. Passing an `AbortSignal` cancels provider work; worker termination cancels pending evaluations. The host does not automatically retry evaluations. Each call checks current and delegated permissions. Non-committing macro resolution cannot run evaluations.

## Inspect connections

```ts
const providers = await spindle.decisions.listProviders()
const connections = await spindle.decisions.listConnections()
const connection = await spindle.decisions.getConnection(connectionId)
const models = await spindle.decisions.getModels(connectionId)
```

Each inspection method accepts an optional `{ userId }` argument for operator extensions. Profiles include model, default status, and readable API-key status, without credentials. Model entries include `id`, `label`, optional catalog metadata, and a `protocol` value of `supported`, `unsupported`, or `unverified`. Preserve exact model IDs, including `~typesafe/jev-latest`. Unknown models can be entered manually. Together's Tev1 uses a different protocol and is rejected by this adapter.

OpenRouter uses its native `/api/alpha/decisions` route and discovers Decision models through `/api/v1/models?output_modalities=decisions`. TypeSafe uses `/v1/systemone` and `/v1/models`. Custom API URLs are versioned base URLs; proxy deployments must expose the corresponding evaluation and model routes. Only supported OpenRouter `provider` routing options are accepted in `default_parameters`.

See [Decision connection setup](https://lumiverse.chat/guides/connections/decisions/) and the [REST reference](../rest-api.md#decision-connections).
