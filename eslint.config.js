import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

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
    // docs/assets/source holds one-off asset-generation scripts (browser +
    // node globals mixed), same category as src-tauri/icons/source.
    // .claude/ holds agent worktrees — full repo mirrors whose nested paths
    // dodge the root-relative patterns above and false-fail the lint.
    ignores: ['dist/', 'src-tauri/', 'node_modules/', 'docs/assets/source/', '.claude/'],
  },
);
