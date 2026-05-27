import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import pkg from './package.json'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'inline',
      manifest: false,
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
        // Main app chunk is ~5MB; locale JSON are separate lazy chunks (see src/i18n/resources.ts).
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
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
    lightningcss: {
      // Safari 14 still requires -webkit-backdrop-filter. Setting this target
      // tells Lightning CSS to emit both prefixed and unprefixed forms
      // automatically — manual -webkit- prefixes are removed from source.
      targets: {
        safari: (14 << 16),
      },
    },
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  build: {
    // Vite 8 defaults build.cssMinify to 'lightningcss', which requires the
    // lightningcss-<platform>-<arch> native binding to load at build time.
    // On Termux/Android arm64 the binding install is unreliable, and when it
    // fails the production build emits no CSS — pin to esbuild so the minify
    // step uses a binding we ship and can rely on across platforms.
    cssMinify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/')
          const m = normalized.match(/\/i18n\/locales\/([^/]+)\//)
          if (m) return `i18n-${m[1]}`
        },
        chunkFileNames(chunkInfo) {
          const name = chunkInfo.name ?? ''
          if (name.startsWith('i18n-')) {
            const lang = name.slice('i18n-'.length)
            return `assets/i18n/${lang}-[hash].js`
          }
          return 'assets/[name]-[hash].js'
        },
      },
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
