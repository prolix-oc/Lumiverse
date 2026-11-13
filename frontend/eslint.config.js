import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'dist/**',
      '.tmp/**',
      '.dist-build*/**',
      '.dist-backup*/**',
      'node_modules/**',
      'src/sw.ts',
      'scripts/**',
      '**/*.d.ts',
      'src/lib/generated*.ts',
    ],
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Keep the old compiler plugin's correctness checks. Its defaults did
      // not report ref access, memoization bailouts, or effect-setState advice.
      // Adopting the broader recommended preset is a separate UI refactor.
      ...Object.fromEntries([
        'config', 'gating', 'error-boundaries', 'globals', 'immutability',
        'purity', 'set-state-in-render', 'static-components', 'use-memo',
      ].map((rule) => [`react-hooks/${rule}`, 'error'])),
    },
  },
]
