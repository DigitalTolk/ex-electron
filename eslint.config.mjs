import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    // vendor/: CI's ruby/setup-ruby installs fastlane's gems (with their own JS)
    // into vendor/bundle for the Mac App Store job.
    ignores: ['dist/**', 'release/**', 'build/**', 'node_modules/**', 'vendor/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain-JS build/install scripts run under Node, not Electron or the DOM.
    // They stay dependency-free (postinstall must work before devDependencies
    // like tsx are usable), so they get Node globals rather than the TS setup.
    files: ['scripts/**/*.{mjs,js}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
];
