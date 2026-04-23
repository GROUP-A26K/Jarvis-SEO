// eslint.config.js — Jarvis-SEO ESLint flat config (v9, CJS)
// PR 1.4
//
// Jarvis-SEO is Node.js CJS throughout. No React, no JSX.
// simple-import-sort does not apply to require() patterns — omitted here.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Ignore globally
  {
    ignores: [
      '**/node_modules/**',
      'dist/',
      'build/',
      'coverage/',
      'data/',
      'images/',
      'reports/',
      'logs/',
      'secrets/',
      '*.db',
      '*.db-journal',
    ],
  },

  // Base JS recommended for all JS files
  js.configs.recommended,

  // ─────────────────────────────────────────────────────────────
  // scripts/, scripts/lib/, scripts/handlers/ — Node.js CJS
  // ─────────────────────────────────────────────────────────────
  {
    files: ['scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      // ── Style / safety baseline (~20 rules)
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-debugger': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-duplicate-imports': 'error',
      'prefer-template': 'warn',
      'object-shorthand': ['warn', 'always'],
      'no-useless-rename': 'warn',
      'no-useless-return': 'warn',
      'no-else-return': ['warn', { allowElseIf: false }],
      'prefer-arrow-callback': 'warn',
      'no-throw-literal': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'require-atomic-updates': 'off',
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Root tooling (lint-staged, eslint.config itself) — CJS
  // ─────────────────────────────────────────────────────────────
  {
    files: ['*.cjs', '*.config.cjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
