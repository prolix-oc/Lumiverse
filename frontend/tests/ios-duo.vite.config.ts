import { defineConfig } from 'vite'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import base from '../vite.config.ts'

const root = path.resolve(import.meta.dirname, '..')
const observations = path.resolve(root, '../.tmp/ios-duo-observations.jsonl')

// Local-only native simulator fixture. API replies contain synthetic data.
export default defineConfig({
  ...base,
  root,
  optimizeDeps: { entries: ['tests/ios-duo.fixture.tsx'] },
  plugins: [{
    name: 'ios-duo-fixture',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0]
        if (pathname === '/layout-snapshots' || pathname === '/fixture-errors') {
          let body = ''
          for await (const chunk of req) body += chunk
          mkdirSync(path.dirname(observations), { recursive: true })
          appendFileSync(observations, JSON.stringify({ path: pathname, body: JSON.parse(body) }) + '\n')
          res.statusCode = 204
          res.end()
          return
        }
        if (pathname?.startsWith('/api/')) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(pathname === '/api/v1/runtime-config' ? { safeThemeMode: false } : { data: [] }))
          return
        }
        if (pathname === '/') {
          res.setHeader('Content-Type', 'text/html')
          res.end(await server.transformIndexHtml('/', `<!doctype html><html><head>
            <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
            </head><body><div id="root"></div>
            <script>window.addEventListener('error', e => fetch('/fixture-errors', {method:'POST',body:JSON.stringify({message:e.message,stack:e.error?.stack})}));</script>
            <script type="module" src="/tests/ios-duo.fixture.tsx"></script></body></html>`))
          return
        }
        next()
      })
    },
  }],
  server: { host: '127.0.0.1', port: 18571, strictPort: true },
})
