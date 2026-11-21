import { Hono } from 'hono'
import { serveStatic } from '@hono/bun'

export function frontendStaticRoutes(root: string): Hono {
  const routes = new Hono()
  routes.use('*', async (c, next) => {
    await next()
    const path = c.req.path
    if (path.startsWith('/api/')) return
    // Only successful, fingerprinted assets are immutable. In particular,
    // theme-reference-index.json is a mutable pointer to the current build.
    const immutable = c.res.status === 200 && path.startsWith('/assets/')
      && /(?:-[\w-]{8}|\.[a-f0-9]{64})\.[a-z0-9]+$/i.test(path)
      && !c.res.headers.get('Content-Type')?.includes('text/html')
    c.res.headers.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    if (path === '/manifest.json' && c.res.status === 200) {
      c.res.headers.set('Content-Type', 'application/manifest+json')
    }
    if (path === '/sw.js') c.res.headers.set('Service-Worker-Allowed', '/')
  })
  routes.use('*', serveStatic({ root }))
  routes.use('*', async (c, next) => {
    // An old import map may request a removed chunk. Returning index.html here
    // used to cache HTML for a year under that JS URL and hide the real 404.
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')
      || /\.[a-z0-9]+$/i.test(c.req.path)) return next()
    return serveStatic({ root, path: 'index.html' })(c, next)
  })
  return routes
}
