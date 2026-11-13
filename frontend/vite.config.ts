import { themeReferenceBuild } from './scripts/theme-reference-build.ts'
import { defineConfig } from 'vite'
import { createReactCompilerPlugins } from './scripts/react-compiler.ts'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import pkg from './package.json' with { type: 'json' }

const chunkImportMap = process.env.LUMIVERSE_CHUNK_IMPORT_MAP !== '0'

export default defineConfig({
  experimental: { bundledDev: process.env.LUMIVERSE_BUNDLED_DEV !== '0' },
  plugins: [
    themeReferenceBuild(),
    {
      name: 'lumiverse-bundled-refresh-order',
      config(config, { command }) {
        if (command !== 'serve' || !config.experimental?.bundledDev) return
        // The app and widget share React chunks. Preserve initialization order
        // so their refresh wrappers run after the preamble in bundled dev.
        // https://github.com/vitejs/vite-plugin-react/issues/1191
        return { build: { rolldownOptions: { output: { strictExecutionOrder: true } } } }
      },
    },
    ...createReactCompilerPlugins(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // main.tsx imports virtual:pwa-register so it can own update UI and the
      // guarded reload policy. Do not inject a second raw registration.
      injectRegister: false,
      manifest: false,
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      injectManifest: {
        globPatterns: [
          '**/*.{js,css,html,ico,png,svg,webp,woff,woff2}',
          // Keep the emitted map with the matching precached HTML/assets.
          ...(chunkImportMap ? ['importmap.json'] : []),
        ],
        // Main app chunk is ~5MB; locale JSON are separate lazy chunks (see src/i18n/resources.ts).
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      integration: {
        configureCustomSWViteBuild(config) {
          const build = config.build
          if (!build) return
          // Workers cannot use document import maps. Only application HTML
          // gets a map; the custom worker stays a single self-contained file.
          build.chunkImportMap = false
          // vite-plugin-pwa still generates the deprecated option name.
          const options = build.rolldownOptions ?? build.rollupOptions
          if (!options) return
          build.rolldownOptions = options
          delete build.rollupOptions
          const output = options.output as
            | Record<string, unknown>
            | undefined
          if (output) {
            delete output.inlineDynamicImports
            output.codeSplitting = false
          }
        },
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    // Shared source lives outside frontend/; resolve its Spindle runtime from
    // this application's dependencies even when the backend copy is older.
    dedupe: ['lumiverse-spindle-types', 'fflate'],
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
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
    // Standard builds use stable chunk references. Set the environment
    // variable to 0 only when diagnosing an older browser/runtime.
    chunkImportMap,
    // Vite 8 defaults build.cssMinify to 'lightningcss', which requires the
    // lightningcss-<platform>-<arch> native binding to load at build time.
    // On Termux/Android arm64 the binding install is unreliable, and when it
    // fails the production build emits no CSS — pin to esbuild so the minify
    // step uses a binding we ship and can rely on across platforms.
    cssMinify: 'esbuild',
    chunkSizeWarningLimit: 6000,
    rolldownOptions: {
      input: {
        main: path.resolve(import.meta.dirname, './index.html'),
        widget: path.resolve(import.meta.dirname, './widget.html'),
      },
      output: {
        codeSplitting: {
          groups: [{
            debugName: 'i18n-locales',
            name(id) {
              const normalized = id.replace(/\\/g, '/')
              const match = normalized.match(/\/i18n\/locales\/([^/]+)\//)
              return match ? `i18n-${match[1]}` : null
            },
          }],
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
