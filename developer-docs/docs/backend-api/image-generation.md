# Image Generation

!!! warning "Permission required: `image_gen`"

Generate images programmatically via the user's configured image gen connection profiles. Supports listing providers, connections, available models, and firing image generations.

## `spindle.imageGen.generate(input)`

Generate an image using a connection profile. If `connection_id` is omitted, uses the user's default image gen connection.

```ts
const result = await spindle.imageGen.generate({
  prompt: 'A serene mountain landscape at sunset, anime style',
  connection_id: 'optional-connection-id',
})
// result: { imageDataUrl: "data:image/png;base64,...", model: "...", provider: "..." }
```

You can override the model and pass provider-specific parameters:

```ts
const result = await spindle.imageGen.generate({
  prompt: '1girl, fantasy armor, detailed background',
  connection_id: 'my-novelai-connection',
  model: 'nai-diffusion-4-5-full',
  parameters: {
    resolution: '1024x1024',
    steps: 35,
    guidance: 7,
    sampler: 'k_euler_ancestral',
  },
})
```

For full control, use `rawRequestOverride` to deep-merge arbitrary JSON into the provider's request body:

```ts
const result = await spindle.imageGen.generate({
  prompt: 'A futuristic cityscape',
  parameters: {
    rawRequestOverride: JSON.stringify({
      generationConfig: {
        imageGenerationConfig: { aspectRatio: '21:9' },
      },
    }),
  },
})
```

### ImageGenRequestDTO

| Field | Type | Description |
|---|---|---|
| `prompt` | `string` | **Required.** Text prompt for image generation. |
| `connection_id` | `string` | Optional. Use a specific image gen connection profile. If omitted, uses the user's default. |
| `model` | `string` | Optional. Override the connection profile's model. |
| `negativePrompt` | `string` | Optional. Negative prompt (provider-dependent). |
| `parameters` | `Record<string, unknown>` | Optional. Provider-specific parameters, merged with the connection's `default_parameters`. |
| `userId` | `string` | **Required for operator-scoped extensions.** |

### ImageGenResultDTO

| Field | Type | Description |
|---|---|---|
| `imageDataUrl` | `string` | Base64-encoded data URL of the generated image (e.g. `data:image/png;base64,...`). |
| `model` | `string` | The model that was used. |
| `provider` | `string` | The provider that was used (`google_gemini`, `nanogpt`, `novelai`). |
| `imageId` | `string` | Optional. The persisted image ID in the images table. Present when persistence succeeds. |
| `imageUrl` | `string` | Optional. Public URL path for the image (e.g. `/api/v1/image-gen/results/{id}`). Works without authentication — suitable for push notification `image` field, embeds, and external references. |

### Image Persistence

Generated images are automatically saved to the images table with full thumbnail support. The `imageId` can be used to reference the image in other APIs (gallery, backgrounds, etc.), and `imageUrl` provides unauthenticated public access.

### Push Notification Integration

The `imageUrl` is designed to work with push notifications. Since push payloads can't carry inline images, use the URL in the `image` field:

```ts
const result = await spindle.imageGen.generate({
  prompt: 'A cozy campfire scene at night',
})

if (result.imageUrl) {
  await spindle.push.send({
    title: 'Scene Generated',
    body: 'A new background image is ready',
    image: result.imageUrl,
  })
}
```

The `?size=sm` or `?size=lg` query parameter can be appended to get thumbnails:

```ts
const thumbUrl = `${result.imageUrl}?size=sm`  // ~300px thumbnail
```

---

## `spindle.imageGen.getProviders(userId?)`

List available image generation providers with their capability schemas. The schemas describe each provider's supported parameters, models, and features — useful for building dynamic settings UIs.

```ts
const providers = await spindle.imageGen.getProviders()

for (const provider of providers) {
  spindle.log.info(`${provider.name} (${provider.id})`)
  spindle.log.info(`  Models: ${provider.capabilities.staticModels?.map(m => m.label).join(', ')}`)
  spindle.log.info(`  Parameters: ${Object.keys(provider.capabilities.parameters).join(', ')}`)
}
```

### ImageGenProviderDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Provider identifier (`google_gemini`, `nanogpt`, `novelai`). |
| `name` | `string` | Display name. |
| `capabilities` | `object` | Provider capabilities (see below). |

### Capabilities

| Field | Type | Description |
|---|---|---|
| `parameters` | `Record<string, ImageGenParameterSchemaDTO>` | Supported parameters with types, defaults, min/max, options. |
| `apiKeyRequired` | `boolean` | Whether an API key is required. |
| `modelListStyle` | `"static" \| "dynamic" \| "google"` | How models are listed: baked-in, live API fetch, or Google model filtering. |
| `staticModels` | `Array<{ id, label }>` | Baked-in model list (always present for `static` providers). |
| `defaultUrl` | `string` | Default API endpoint. |

### ImageGenParameterSchemaDTO

| Field | Type | Description |
|---|---|---|
| `type` | `string` | `"number"`, `"integer"`, `"boolean"`, `"string"`, `"select"`, `"image_array"`. |
| `default` | `unknown` | Default value. |
| `min`, `max`, `step` | `number` | Range constraints (for numeric types). |
| `description` | `string` | Human-readable description. |
| `options` | `Array<{ id, label }>` | Fixed options (for `select` type). |
| `group` | `string` | UI grouping hint (`"advanced"`, `"references"`). |

---

## `spindle.imageGen.listConnections(userId?)`

List the user's image gen connection profiles. API keys are never exposed — only the `has_api_key` boolean.

```ts
const connections = await spindle.imageGen.listConnections()

for (const conn of connections) {
  spindle.log.info(`${conn.name} (${conn.provider}) — model: ${conn.model}`)
}
```

### ImageGenConnectionDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Connection profile ID. |
| `name` | `string` | Display name. |
| `provider` | `string` | Provider identifier. |
| `api_url` | `string` | Custom API endpoint (empty = provider default). |
| `model` | `string` | Selected model. |
| `is_default` | `boolean` | Whether this is the user's default image gen connection. |
| `has_api_key` | `boolean` | Whether an API key is configured (value never exposed). |
| `default_parameters` | `Record<string, unknown>` | Provider-specific default parameters. |
| `metadata` | `Record<string, unknown>` | Arbitrary metadata. |
| `created_at` | `number` | Unix epoch seconds. |
| `updated_at` | `number` | Unix epoch seconds. |

---

## `spindle.imageGen.getConnection(connectionId, userId?)`

Get a single image gen connection profile by ID. Returns `null` if not found.

```ts
const conn = await spindle.imageGen.getConnection('connection-id')
if (conn) {
  spindle.log.info(`Using ${conn.name} with model ${conn.model}`)
}
```

---

## `spindle.imageGen.getModels(connectionId, userId?)`

List available models for a specific connection profile. For providers with dynamic model lists (e.g. NanoGPT), this fetches live from the upstream API.

```ts
const models = await spindle.imageGen.getModels('connection-id')

for (const model of models) {
  spindle.log.info(`${model.id}: ${model.label}`)
}
```

Returns `Array<{ id: string; label: string }>`.
