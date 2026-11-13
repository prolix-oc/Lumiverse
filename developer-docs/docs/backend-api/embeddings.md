# Embeddings

`spindle.embeddings` turns text into vectors with the user's embedding connections (Settings > Embeddings). Use it to rank short texts by meaning, for example to match a spoken request against command labels. Declare the `embeddings` permission in `spindle.json` and obtain the user's grant. The host advertises `embeddings-v1: 1` in `spindle.host.capabilities`; check this before calling the API on older hosts.

Use `lumiverse-spindle-types` **0.6.53** or newer for `SpindleEmbeddingsAPI`, the `Embedding*` types, and the `embeddings` permission.

## Embed

```ts
const labels = ['Open world books', 'Switch persona', 'Start a new chat']
const { embeddings, connection_id, model, dimensions } = await spindle.embeddings.embed({ texts: labels })

const [query] = (await spindle.embeddings.embed({
  texts: ['take me to my lorebooks'],
  input_type: 'query',
  connection_id, // same connection, so the vectors are comparable
}, { signal: controller.signal })).embeddings

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / Math.sqrt(na * nb)
}
const best = labels[embeddings.map((v) => cosine(query, v)).reduce((bi, s, i, all) => (s > all[bi] ? i : bi), 0)]
```

The result has one vector per text, in input order, plus the `connection_id`, `model`, and `dimensions` that produced them. Vectors from different connections or models are not comparable. If you store vectors, store `connection_id` and `model` with them and embed again when they change.

- `connection_id` selects a connection from `listConnections()`. Without it, the host uses the user's primary embedding connection. The host never switches to a fallback connection for this API, so all vectors in a result come from one model. An unknown or disabled connection fails the request.
- `input_type` is `"passage"` (default) or `"query"`. Some models (Cohere, NVIDIA NIM) embed search queries differently from stored texts. Embed what you search for as `"query"` and what you search in as `"passage"`.
- A request has 1–256 texts. Each text must be non-empty and at most 8192 characters. Split larger sets into several requests.
- The host sends texts to the provider in batches of the user's embedding batch size.
- The request fails when the user has turned embeddings off.
- Results use the host's embedding cache (10 minutes), scoped to the selected connection and input type, so repeated extension requests do not call the provider again. Host retrieval uses separate entries because its vectors may come from a fallback connection.

Extensions never supply credentials or endpoints, and errors never contain the API key. User extensions always resolve their owner's account. Operator extensions must supply `userId`. When the server owner shares their embedding setup with other accounts, those accounts embed with the owner's connections, as host features do.

Passing an `AbortSignal` cancels provider work; worker termination cancels pending requests. Non-committing macro resolution cannot run `embed`.

Only text is supported. No built-in embedding provider path sends images.

## List connections

```ts
const connections = await spindle.embeddings.listConnections()
const primary = connections.find((c) => c.is_primary)
```

Each connection has `id`, `name`, `provider`, `model`, `dimensions` (`null` means the provider's native size), `enabled`, `is_primary`, and `has_api_key`. URLs and API keys are not returned.
