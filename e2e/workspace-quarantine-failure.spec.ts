import { expect, test } from '@playwright/test';
import { setupMemoryTauri } from './helpers/memoryTauri';

const INVALID_WORKSPACE = '{ original invalid workspace bytes';

test('a quarantine failure preserves recovery bytes and keeps persistence suspended', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-07-14T21:00:00-05:00') });
  await setupMemoryTauri(page, { workspace: INVALID_WORKSPACE });

  const recovery = page.getByRole('dialog', { name: 'Workspace recovery could not be read' });
  await expect(recovery).toBeVisible();
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__ as {
      invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    };
    const originalInvoke = internals.invoke.bind(internals);
    internals.invoke = async (cmd, args) => {
      if (cmd === 'quarantine_draft') {
        window.__quillCalls.push({ cmd, args });
        throw new Error('App-data directory is read-only');
      }
      return originalInvoke(cmd, args);
    };
  });

  await recovery.getByRole('button', { name: 'Preserve & Continue' }).click();

  const notice = page.getByRole('dialog', { name: 'Could not preserve workspace recovery' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Quill has not overwritten the recovery file');
  await notice.getByRole('button', { name: 'OK' }).click();
  await expect(recovery).toBeVisible();

  // A failed acknowledgement must not re-enable the autosave that would
  // overwrite the evidence. Advancing well past the autosave interval proves
  // persistence remains suspended without adding a wall-clock sleep.
  await page.clock.runFor(20_000);
  const persisted = await page.evaluate(() => ({
    raw: sessionStorage.getItem('__quill_test_workspace'),
    writes: window.__quillCalls.filter((call) => call.cmd === 'write_draft').length,
    quarantines: window.__quillCalls.filter((call) => call.cmd === 'quarantine_draft').length,
  }));
  expect(persisted).toEqual({ raw: INVALID_WORKSPACE, writes: 0, quarantines: 1 });
});
