import { realpathSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

const projectRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Test-only Vite entrypoint. Worktrees share the primary checkout's
 * node_modules directory, which lives outside Vite's default filesystem
 * allowlist. Serving the resolved dependency directory keeps the bundled
 * fonts identical locally and in CI without relaxing the production config.
 */
export default defineConfig({
  root: projectRoot,
  plugins: [react()],
  server: {
    strictPort: true,
    fs: {
      allow: [
        searchForWorkspaceRoot(projectRoot),
        realpathSync(path.join(projectRoot, 'node_modules')),
      ],
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
