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
