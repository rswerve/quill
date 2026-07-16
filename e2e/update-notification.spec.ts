import { expect, test } from '@playwright/test';
import { setupMemoryTauri } from './helpers/memoryTauri';

interface ReleaseFixture {
  tag_name: string;
  html_url: string;
}

async function mountUpdateHarness(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    let host = document.querySelector<HTMLElement>('[data-update-integration-host]');
    if (!host) {
      host = document.createElement('div');
      host.dataset.updateIntegrationHost = 'true';
      document.body.appendChild(host);
    }
    const module = await import('/e2e/helpers/updateNotificationHarness.tsx');
    module.mountUpdateNotificationHarness(host);
  });
}

test('a newer release opens externally, stays dismissed, and a later version reappears', async ({
  page,
}) => {
  let release: ReleaseFixture = {
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/sam-powers/quill/releases/tag/v9.9.9',
  };
  let requests = 0;
  await page.route(
    'https://api.github.com/repos/sam-powers/quill/releases/latest',
    async (route) => {
      requests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(release),
      });
    },
  );
  await setupMemoryTauri(page);

  await mountUpdateHarness(page);
  const banner = page.locator('[data-update-integration-host]').getByRole('status');
  await expect(banner).toContainText('Quill 9.9.9 is available.');
  await banner.getByRole('button', { name: 'View release' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__quillCalls.find((call) => call.cmd === 'plugin:opener|open_url')?.args.url,
      ),
    )
    .toBe('https://github.com/sam-powers/quill/releases/tag/v9.9.9');

  await banner.getByRole('button', { name: 'Dismiss update notification' }).click();
  await expect(banner).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('quill.dismissed-update')))
    .toBe('9.9.9');

  const requestsBeforeDismissedRemount = requests;
  await mountUpdateHarness(page);
  await expect.poll(() => requests).toBeGreaterThan(requestsBeforeDismissedRemount);
  await expect(banner).toHaveCount(0);

  release = {
    tag_name: 'v10.0.0',
    html_url: 'https://github.com/sam-powers/quill/releases/tag/v10.0.0',
  };
  const requestsBeforeNewerRemount = requests;
  await mountUpdateHarness(page);
  await expect.poll(() => requests).toBeGreaterThan(requestsBeforeNewerRemount);
  await expect(banner).toContainText('Quill 10.0.0 is available.');
});
