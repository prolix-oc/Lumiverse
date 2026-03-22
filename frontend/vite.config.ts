import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import pkg from './package.json'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Use existing manifest.json in public/
      manifest: false,
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
        // SPA: route all navigation to index.html
        navigateFallback: 'index.html',
        // Don't intercept API calls
        navigateFallbackDenylist: [/^\/api/, /^\/uploads/],
        // Hashed assets are immutable — skip revision hashing for them
        dontCacheBustURLsMatching: /\.[a-f0-9]{8}\./,
        runtimeCaching: [
          {
            // Cache avatar and image requests
            urlPattern: /\/api\/v1\/(characters|personas)\/[^/]+\/avatar/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'avatar-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: /\/api\/v1\/images\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  server: {
    host: '::',
    proxy: {
      '/api/auth': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/v1': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/spindle-oauth': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/ws': {
        target: 'ws://localhost:7860',
        ws: true,
      },
      '/uploads': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
    },
  },
})
