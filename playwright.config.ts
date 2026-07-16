import { defineConfig, devices } from '@playwright/test';

// Dedicated worktrees may be tested while Maz is driving another build on
// Quill's default port. Keep CI/local defaults unchanged while allowing an
// isolated server so a suite can never silently exercise the wrong checkout.
const e2ePort = Number(process.env.QUILL_E2E_PORT ?? 1420);
const e2eUrl = `http://localhost:${e2ePort}`;

/**
 * Playwright drives the app through the Vite dev server (the same bundle the
 * Tauri window loads). Tauri-native commands are stubbed per-test via
 * window.__quillMock / __TAURI_INTERNALS__ shims, so no Rust process is needed.
 *
 * Unit tests live under src/test/ and belong to vitest; these end-to-end
 * specs live under e2e/, so the two runners never collide.
 */
export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/visual/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: e2eUrl,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /visual\//,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual',
      testMatch: /visual\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1240, height: 800 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'America/Chicago',
        colorScheme: 'light',
        trace: 'retain-on-failure',
      },
    },
  ],
  webServer: {
    command: `npx vite --config e2e/visual/vite.e2e.config.ts --port ${e2ePort}`,
    url: e2eUrl,
    // An explicitly isolated worktree run must own its server. Default local
    // runs retain the convenient reuse behavior on Quill's canonical port.
    reuseExistingServer: process.env.QUILL_E2E_PORT ? false : !process.env.CI,
    timeout: 30_000,
  },
});
