# UUIDs

`spindle.uuid` generates UUID strings using the backend's existing UUID helper.
It is available to backend extensions without any permission or user ID.

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const randomId = await spindle.uuid.v4()
const orderedId = await spindle.uuid.v7()
```

| Method | Returns | Description |
|--------|---------|-------------|
| `v4()` | `Promise<string>` | Random UUID with 122 random bits |
| `v7()` | `Promise<string>` | UUID with the backend's millisecond Unix timestamp, a 12-bit counter, and 62 random bits |

Both methods return lowercase UUID strings in `8-4-4-4-12` hexadecimal format.
Each call makes a request to the backend host. UUID v7 calls share the helper's
counter with other calls in that backend process, including calls from other
extensions, and increase monotonically within the same millisecond.

For extensions that also support older hosts, check the capability before use:

```ts
if ((spindle.host.capabilities['uuid-v1'] ?? 0) >= 1) {
  const id = await spindle.uuid.v7()
}
```
