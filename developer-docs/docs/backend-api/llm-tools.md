# LLM Tools

!!! warning "Permission required: `tools`"

Register tools (function calling) that LLM providers can invoke during generation.

```ts
spindle.registerTool({
  name: 'search_knowledge_base',
  display_name: 'Search Knowledge Base',
  description: 'Searches the extension knowledge base for relevant information',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results', default: 5 },
    },
    required: ['query'],
  },
  council_eligible: false,
})

// Unregister
spindle.unregisterTool('search_knowledge_base')
```

## ToolRegistrationDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique tool identifier |
| `display_name` | `string` | Human-readable name |
| `description` | `string` | Description for the LLM (used in function calling) |
| `parameters` | `JSONSchema` | JSON Schema defining the tool's input arguments |
| `council_eligible` | `boolean` | Optional. Reserved for future Council mode integration |

The `extension_id` field is set automatically by the host — you don't need to provide it.
