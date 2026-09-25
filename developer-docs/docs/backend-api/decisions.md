# Decision Models

!!! warning "Permission required: `decisions`"

Decision models evaluate structured questions through the user's Decision Models connections. They are separate from chat generation: `spindle.generate` and the chat model picker cannot select Jev. An extension must declare `"decisions"` in its manifest and receive an explicit user grant. The `generation` permission does not grant decision access.

Create a connection in **Connections → Decision Models** before evaluating. Lumiverse uses the authenticated user's default decision connection when `connectionId` is omitted. You can select another connection owned by that user with `connectionId`. The host supplies the user identity and stored API key; neither belongs in the request.

## `spindle.decisions.evaluate(request)`

```ts
const result = await spindle.decisions.evaluate({
  state: {
    ticket: { message: 'I was charged twice', charges: [42, 42] },
  },
  questions: {
    route: {
      type: 'choice',
      instructions: { goal: 'Select the team that should handle this ticket' },
      criteria: {
        billing: { handles: 'payments and refunds' },
        support: { handles: 'account troubleshooting' },
      },
    },
    severity: {
      type: 'score',
      instructions: 'Rate the impact from lowest to highest',
      criteria: ['Low', 'Medium', 'High'],
    },
    urgent: {
      type: 'noul',
      instructions: 'Does this need immediate attention?',
      criteria: { true: 'Act now', false: 'Normal queue' },
    },
  },
})

const team = result.answers.route
if (team.type === 'choice') spindle.log.info(team.choice)
```

The call returns one answer per question ID. A gateway that cannot serve a requested primitive returns an unsupported-primitive error.

## Request shape

```ts
type DecisionData = string | Record<string, unknown> | unknown[]

type DecisionQuestion =
  | { type: 'choice'; instructions: DecisionData; criteria: Record<string, DecisionData | null> }
  | { type: 'score'; instructions: DecisionData; criteria: DecisionData[] }
  | { type: 'noul'; instructions: DecisionData; criteria?: { true?: DecisionData; false?: DecisionData } }

interface DecisionRequest {
  connectionId?: string
  state: DecisionData
  questions: Record<string, DecisionQuestion>
}
```

`state`, `instructions`, and `criteria` retain their structured JSON values through the provider adapter. Every request needs 1–100 named questions. Each question needs `instructions` as a string, object, or array.

| Question `type` | `criteria` | Meaning |
|---|---|---|
| `choice` | Record of 2–255 option IDs to structured descriptions or `null` | Select an option and return its probability distribution |
| `score` | Ordered array of 2–10 structured level descriptions | Return a numeric score, level legend, and distribution |
| `noul` | Optional `{ true?, false? }` structured descriptions | Return a probability between 0 and 1 |

The caller cannot supply `userId` or `user_id`. The connection must belong to the authenticated user. If `connectionId` is omitted and no default exists, evaluation fails.

## Result shape

```ts
interface DecisionResult {
  model: string
  answers: Record<string,
    | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
    | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
    | { type: 'noul'; noul: number }
  >
  usage?: { input_tokens: number; output_tokens: number }
}
```

`model` identifies the model returned by the gateway. `usage` appears only when the gateway supplies token counts.

## Connections and gateways

Jev is the first decision provider. Connection presets include TypeSafe, OpenRouter, NanoGPT, Vercel AI Gateway, Cloudflare Workers AI, Venice, MindsHub, AI/ML API, AICU, and Anoman. Presets provide a decision endpoint and editable model ID. Cloudflare also needs an account ID. For another deployment, choose **Custom** and explicitly select a supported decision API protocol along with its URL, model ID, and API key. The supported protocol IDs are `typesafe`, `openrouter`, `nanogpt`, `vercel`, `cloudflare`, `venice`, `mindshub`, `aimlapi`, `aicu`, and `anoman`. Account-scoped deployments such as Convex and Netlify use **Custom** with the matching protocol and their own endpoint.

Connections are private to each user and have one default per user. The Connections UI can create, edit, duplicate, delete, set a default, and test them. A test sends a small Noul question to the gateway. Backups and imports carry connection metadata without API keys; imported connections need a new key before use.

See the [REST API](../rest-api.md#decision-models-api) for the authenticated HTTP endpoints and the [frontend decision API](../frontend-api/decisions.md) for `ctx.decisions.evaluate`.
