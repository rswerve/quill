import {
  test as base,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';
import { isCollectableCoverageUrl } from '../scripts/coveragePaths.mjs';

const collectCoverage = process.env.E2E_COVERAGE === '1';

async function startCoverage(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    await page.coverage.startJSCoverage({
      reportAnonymousScripts: false,
      resetOnNavigation: false,
    });
    return true;
  } catch (error) {
    // A short-lived popup can close in the same turn as the `page` event.
    // Losing that popup's coverage is safe; masking any other CDP failure is not.
    if (page.isClosed()) return false;
    throw error;
  }
}

async function stopCoverage(page: Page) {
  if (page.isClosed()) return [];
  return page.coverage.stopJSCoverage();
}

/**
 * The stock Playwright HTML report answers which browser scenarios passed; it
 * does not measure which application lines executed. This automatic fixture
 * records Chromium's native V8 coverage for every page used by every E2E test.
 * `resetOnNavigation:false` is load-bearing for reload/reopen scenarios.
 */
export const test = base.extend<{ codeCoverage: void }>({
  codeCoverage: [
    async ({ browserName, context, page }, use, testInfo) => {
      if (!collectCoverage || browserName !== 'chromium') {
        await use();
        return;
      }

      const coverageStarts = new Map<Page, Promise<boolean>>();
      const coverPage = (candidate: Page) => {
        if (!coverageStarts.has(candidate)) {
          coverageStarts.set(candidate, startCoverage(candidate));
        }
      };
      const onPage = (candidate: Page) => coverPage(candidate);

      coverPage(page);
      context.on('page', onPage);
      await Promise.all(coverageStarts.values());

      try {
        await use();
      } finally {
        context.off('page', onPage);
        await Promise.all(coverageStarts.values());
        const entries = (
          await Promise.all(
            [...coverageStarts.entries()].map(async ([candidate, started]) => {
              return (await started) ? stopCoverage(candidate) : [];
            }),
          )
        ).flat();
        // Shared with the reporter's entryFilter. Keeping the rule in one place
        // is load-bearing: when these were separate copies, widening the
        // reporter's did nothing, because this filter had already discarded the
        // built bundle's chunks and a production run recorded zero coverage
        // while appearing to succeed.
        const applicationEntries = entries.filter((entry) => {
          try {
            return isCollectableCoverageUrl(new URL(entry.url).pathname);
          } catch {
            return false;
          }
        });
        if (applicationEntries.length > 0) {
          await addCoverageReport(applicationEntries, testInfo);
        }
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { BrowserContext, Locator, Page };
