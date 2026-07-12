import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { sonarjs },
    rules: {
      ...sonarjs.configs.recommended.rules,
      // `void promise()` is our deliberate fire-and-forget marker (it satisfies
      // no-floating-promises); the alternative is noisier `.catch(() => {})`.
      'sonarjs/void-use': 'off',
      // Callback-heavy React effects and ProseMirror `nodesBetween` / array
      // methods nest arrow callbacks idiomatically; the depth-4 default flags
      // that idiom, not a genuine nested-named-function pyramid.
      'sonarjs/no-nested-functions': 'off',
      // Default threshold 15 is aggressive and can force over-decomposition
      // that hurts readability; 20 is a pragmatic bar. Functions over it are
      // refactored for legibility (the test suite is the safety net), not
      // suppressed.
      'sonarjs/cognitive-complexity': ['error', 20],
    },
  },
  {
    // ProseMirror plugin/command callbacks have API-mandated return types, so
    // "always returns the same value" is contract conformance here, not a smell
    // (e.g. a command that always reports handled, a decoration hook that
    // always returns false). Every no-invariant-returns hit is one of these.
    files: ['src/extensions/**/*.ts'],
    rules: { 'sonarjs/no-invariant-returns': 'off' },
  },
  {
    // Test code runs on controlled, in-repo fixtures — not untrusted input — so
    // regex-safety heuristics don't carry ReDoS risk; and exact float equality
    // against known rounded expectations is intentional in assertions.
    files: ['src/test/**/*.{ts,tsx}'],
    rules: {
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/regex-complexity': 'off',
      'sonarjs/no-floating-point-equality': 'off',
    },
  },
  {
    // docs/assets/source holds one-off asset-generation scripts (browser +
    // node globals mixed), same category as src-tauri/icons/source.
    // .claude/ holds agent worktrees — full repo mirrors whose nested paths
    // dodge the root-relative patterns above and false-fail the lint.
    ignores: ['dist/', 'src-tauri/', 'node_modules/', 'docs/assets/source/', '.claude/'],
  },
);
