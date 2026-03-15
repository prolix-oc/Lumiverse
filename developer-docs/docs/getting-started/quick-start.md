# Quick Start

## Extension Structure

```
my-extension/
├── spindle.json          # required — extension manifest
├── src/
│   ├── backend.ts        # runs in an isolated Bun worker
│   └── frontend.ts       # runs in the browser
├── dist/                 # compiled output
│   ├── backend.js
│   └── frontend.js
├── tsconfig.json
└── package.json
```

1. Create a GitHub repo with this structure
2. Add a `spindle.json` manifest
3. Write your backend and/or frontend modules
4. Build to `dist/` (or let Lumiverse auto-build from `src/`)
5. Users install via the Extensions panel or `POST /api/v1/spindle/install`

## Backend vs Frontend

Extensions can have a **backend module**, a **frontend module**, or both.

- **Backend** (`dist/backend.js`) — runs in an isolated Bun worker thread. Has access to the `spindle` global API. Cannot access the DOM or Lumiverse internals directly.
- **Frontend** (`dist/frontend.js`) — loaded in the browser via dynamic import. Receives a sandboxed context object with a DOM helper and event system. All HTML is sanitized through DOMPurify.

If your `dist/` folder doesn't exist but `src/backend.ts` and/or `src/frontend.ts` do, Lumiverse will auto-build them with `bun build` on install.

## Next Steps

- [Configure your manifest](manifest.md)
- [Understand permissions](permissions.md)
- [Set up TypeScript](typescript-setup.md)
