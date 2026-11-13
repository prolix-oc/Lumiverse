import { defineConfig } from 'vite'
import path from 'node:path'
import production from './vite.config.ts'
import { createReactCompilerPlugins } from './scripts/react-compiler.ts'

// Shared by the isolated probe and opt-in IPA device preview. Keep application
// source/compiler identical while supplying a self-contained HTTPS document.
export default defineConfig({
  ...production,
  base: '/',
  plugins: [
    ...createReactCompilerPlugins(),
    {
      name: 'native-cache-probe-without-service-worker',
      resolveId(id) { if (id === 'virtual:pwa-register') return '\0native-cache-probe-pwa' },
      load(id) { if (id === '\0native-cache-probe-pwa') return 'export function registerSW() { return async () => {} }' },
    },
  ],
  build: {
    ...production.build,
    // The native probe is inlined into one self-contained HTML document.
    chunkImportMap: false,
    rolldownOptions: {
      input: path.resolve(import.meta.dirname, 'index.html'),
      output: { codeSplitting: false },
    },
  },
})
