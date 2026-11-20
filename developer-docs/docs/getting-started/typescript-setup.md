# TypeScript Setup

For type support in your extension project, install the [`lumiverse-spindle-types`](https://www.npmjs.com/package/lumiverse-spindle-types) package from NPM.

## Install

```bash
# npm
npm install -D lumiverse-spindle-types

# bun
bun add -d lumiverse-spindle-types
```

!!! note
    Previous versions required copying a bundled `.d.ts` file from the Lumiverse server into your project. This is no longer necessary — install the package from NPM instead.

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "./dist",
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

## Building

```bash
# Backend (targeting Bun)
bun build src/backend.ts --outfile dist/backend.js --target bun

# Frontend (targeting browser)
bun build src/frontend.ts --outfile dist/frontend.js --target browser

# Optional lightweight Lumiverse Desktop floating-widget entry
bun build src/widget.ts --outfile dist/widget.js --target browser --minify
```

## Backend Type Declaration

For backend modules, add this at the top of your file to get full type support for the `spindle` global:

```ts
declare const spindle: import('lumiverse-spindle-types').SpindleAPI
```

## Frontend Type Import

For frontend modules, import the context type directly:

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  // fully typed ctx
}
```

For an extension that declares `entry_frontend_widget`, type its dedicated
entry with `SpindleFrontendWidgetTarget`:

```ts
import type {
  SpindleFrontendContext,
  SpindleFrontendWidgetTarget,
} from 'lumiverse-spindle-types'

export function setupWidget(
  ctx: SpindleFrontendContext,
  target: SpindleFrontendWidgetTarget,
) {
  // Register the floating widget needed by the native pop-out.
  // The normal frontend entry continues to export setup(ctx).
}
```

See [Float Widgets](../frontend-api/ui-placement.md#float-widgets-requires-ui_panels)
for the runtime behavior, compatibility fallback, and bundle guidance.
