# Decision Models

`ctx.decisions.evaluate(request)` evaluates the same [normalized decision request](../backend-api/decisions.md#request-shape) as `spindle.decisions.evaluate` and returns the same [result shape](../backend-api/decisions.md#result-shape).

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  async function checkUrgency() {
    if (!ctx.decisions) return
    const result = await ctx.decisions.evaluate({
      state: { message: 'Payment failed during checkout' },
      questions: {
        urgent: {
          type: 'noul',
          instructions: 'Does this require immediate attention?',
          criteria: { true: 'Act now', false: 'Normal queue' },
        },
      },
    })
    const answer = result.answers.urgent
    if (answer.type === 'noul') console.log(answer.noul)
  }

  void checkUrgency()
}
```

Declare `"decisions"` in `spindle.json` and have the user grant it before calling. This is a privileged permission, separate from `generation`. The frontend checks the grant before and after the request; a revoked grant rejects the call. The host uses the authenticated user's decision connection and stored credential. Omit `connectionId` to use that user's default, or specify a decision connection they own.

Decision models do not appear in the chat generation registry or chat model picker. For connection setup and all three question primitives, see the [backend decision reference](../backend-api/decisions.md).
