import { expect, test } from './fixtures';
import { activeEditor, openMemoryFile, setupMemoryTauri } from './helpers/memoryTauri';

const DOC_PATH = '/docs/rich.md';
const RICH_MARKDOWN = `# Rich document

> A quoted line

- [ ] pending task
- [x] finished task

| Name | Value |
| --- | --- |
| one | two |

\`\`\`js
const value = 1;
\`\`\`

![Diagram](./diagram.png)
`;

test('rich Markdown surfaces render together and survive an edited save round-trip', async ({
  page,
}) => {
  await setupMemoryTauri(page, {
    files: { [DOC_PATH]: RICH_MARKDOWN },
    openPath: DOC_PATH,
  });
  await openMemoryFile(page);
  const editor = activeEditor(page);

  await expect(editor.locator('h1')).toHaveText('Rich document');
  await expect(editor.locator('blockquote')).toContainText('A quoted line');
  await expect(editor.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(editor.locator('table')).toContainText('Name');
  await expect(editor.locator('table')).toContainText('two');
  await expect(editor.locator('pre code')).toContainText('const value = 1;');
  await expect(editor.locator('img[alt="Diagram"]')).toHaveCount(1);

  const pendingTask = editor.locator('input[type="checkbox"]').first();
  await expect(pendingTask).not.toBeChecked();
  await pendingTask.click();
  await expect(pendingTask).toBeChecked();

  await editor.locator('pre code').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\nconsole.log(value);');
  await page.keyboard.press('ControlOrMeta+s');

  await expect
    .poll(() =>
      page.evaluate(
        (path) =>
          (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles[path],
        DOC_PATH,
      ),
    )
    .toContain('console.log(value);');

  const saved = await page.evaluate(
    (path) => (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles[path],
    DOC_PATH,
  );
  expect(saved).toContain('- [x] pending task');
  expect(saved).toContain('| Name | Value |');
  expect(saved).toContain('```js');
  expect(saved).toContain('![Diagram](./diagram.png)');
});

test('relative images keep the base directory of their own mounted tab', async ({ page }) => {
  const firstPath = '/docs/one/first.md';
  const secondPath = '/docs/two/second.md';
  await setupMemoryTauri(page, {
    files: {
      [firstPath]: '![First](./shared.png)',
      [secondPath]: '![Second](./shared.png)',
    },
    openPath: firstPath,
  });
  await openMemoryFile(page);

  await page.evaluate((path) => {
    const emit = (window as unknown as { __quillEmit: (event: string, value: string) => void })
      .__quillEmit;
    emit('deep-link-open', path);
  }, secondPath);
  await expect(page.locator('.document-tab.active')).toContainText('second.md');

  const first = page.locator('.document-tab-host', { has: page.locator('img[alt="First"]') });
  const second = page.locator('.document-tab-host', { has: page.locator('img[alt="Second"]') });
  await expect(first.locator('img[alt="First"]')).toHaveAttribute(
    'src',
    'asset://localhost/%2Fdocs%2Fone%2Fshared.png',
  );
  await expect(second.locator('img[alt="Second"]')).toHaveAttribute(
    'src',
    'asset://localhost/%2Fdocs%2Ftwo%2Fshared.png',
  );
});
