import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { applicationSourcePath, isCollectableCoverageUrl } from './scripts/coveragePaths.mjs';

// Dedicated worktrees may be tested while Maz is driving another build on
// Quill's default port. Keep CI/local defaults unchanged while allowing an
// isolated server so a suite can never silently exercise the wrong checkout.
const e2ePort = Number(process.env.QUILL_E2E_PORT ?? 1420);
const e2eUrl = `http://localhost:${e2ePort}`;
const projectRoot = import.meta.dirname;
const collectCoverage = process.env.E2E_COVERAGE === '1';
const useProductionBuild = process.env.E2E_PRODUCTION === '1';
const e2eViteConfig = 'e2e/visual/vite.e2e.config.ts';
const productionOutDir = 'dist-e2e';
// Each CI e2e job writes its own coverage directory so the merge step can take
// both as inputs. Unset (local runs, single-job use) keeps the original path.
const coverageDir = process.env.E2E_COVERAGE_DIR ?? 'coverage/e2e';

const reporters: ReporterDescription[] = process.env.CI
  ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
  : [['list']];

if (collectCoverage) {
  reporters.push([
    'monocart-reporter',
    {
      name: 'Quill end-to-end tests',
      outputFile: `${coverageDir}/tests/index.html`,
      coverage: {
        name: 'Quill Playwright coverage',
        outputDir: coverageDir,
        reports: [
          ['raw', { outputDir: 'raw' }],
          ['v8-json', { outputFile: 'coverage-report.json' }],
          ['json', { file: 'coverage-final.json' }],
          ['lcovonly', { file: 'lcov.info' }],
          ['html', { subdir: 'html' }],
          ['console-summary'],
        ],
        // Shared with the fixture that captures these entries, so the two can
        // never drift apart again.
        entryFilter: (entry: { url?: string }) => {
          if (!entry.url) return false;
          try {
            return isCollectableCoverageUrl(new URL(entry.url).pathname);
          } catch {
            return false;
          }
        },
        sourcePath: (sourcePath: string, info: { distFile?: string }) =>
          applicationSourcePath(sourcePath, info, projectRoot),
      },
    },
  ]);
}

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
  // A test that fails on its first attempt and passes on retry is a real
  // defect, not a pass — retries keep CI moving but must not mask it. Fail the
  // run on any flaky result in CI (this is exactly what hid the Cmd+Shift+S
  // strike collision behind workspace-persistence.spec.ts:185).
  failOnFlakyTests: !!process.env.CI,
  reporter: reporters,
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
        // reducedMotion isn't hoisted to top-level `use` in this Playwright
        // version; it must go through contextOptions to actually take effect.
        contextOptions: { reducedMotion: 'reduce' },
        locale: 'en-US',
        timezoneId: 'America/Chicago',
        colorScheme: 'light',
        trace: 'retain-on-failure',
      },
    },
  ],
  webServer: {
    // E2E_PRODUCTION=1 builds and serves a bundle instead of running the dev
    // server, so the suite exercises something much closer to what ships — and
    // stops paying ~188 module evaluations per page load.
    // Built with the ROOT vite.config.ts — the same config `tauri build` uses —
    // so this lane cannot drift from the artifact that ships. Only the output
    // directory and sourcemaps are overridden, and neither changes runtime
    // behaviour. Building through the test config instead would reintroduce
    // exactly the divergence this lane exists to detect.
    command: useProductionBuild
      ? `npx vite build --outDir ${productionOutDir} --sourcemap && npx vite preview --outDir ${productionOutDir} --port ${e2ePort} --strictPort`
      : `npx vite --config ${e2eViteConfig} --port ${e2ePort}`,
    url: e2eUrl,
    // An explicitly isolated worktree run must own its server. Default local
    // runs retain the convenient reuse behavior on Quill's canonical port.
    //
    // A production run must NEVER reuse: a dev server already listening on this
    // port would be silently accepted, and the run would report success against
    // the very thing it exists not to test.
    reuseExistingServer: !useProductionBuild && !process.env.QUILL_E2E_PORT && !process.env.CI,
    // The production command has to compile the whole app before it can serve
    // anything, and 30s is a comfortable dev-server startup but a tight budget
    // for a cold build on a 4-vCPU runner.
    timeout: useProductionBuild ? 120_000 : 30_000,
  },
});
