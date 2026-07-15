import { expect, test, type Locator, type Page } from '@playwright/test';
import { ipcFixtures } from './helpers/ipcFixtures';
import {
  activeEditor,
  activeTabHost,
  openMemoryFile,
  selectLastCharacters,
  setupMemoryTauri,
} from './helpers/memoryTauri';

const DOC_PATH = '/tmp/type-scale.md';
const SIDECAR_PATH = '/tmp/type-scale.comments.json';
const DOC = 'alpha beta gamma delta **epsilon** zeta';

const sidecar = JSON.stringify({
  version: 2,
  aiSession: ipcFixtures.autoBindSession,
  comments: [
    {
      id: 'comment-1',
      kind: 'claude',
      anchorText: 'zeta',
      from: 32,
      to: 36,
      author: 'Reviewer',
      createdAt: '2026-07-11T18:00:00Z',
      resolved: false,
      replies: [
        {
          id: 'reply-1',
          author: 'Maz',
          authorKind: 'user',
          text: 'Please tighten this.',
          createdAt: '2026-07-11T18:01:00Z',
        },
        {
          id: 'reply-2',
          author: 'Claude',
          authorKind: 'ai',
          model: 'claude-sonnet-4-5',
          text: 'I would make it more direct.',
          createdAt: '2026-07-11T18:02:00Z',
        },
      ],
    },
  ],
  suggestions: [
    {
      id: 'insert-1',
      type: 'insertion',
      from: 1,
      to: 6,
      originalText: '',
      suggestedText: 'alpha',
      author: 'claude',
      createdAt: '2026-07-11T18:03:00Z',
      status: 'pending',
    },
    {
      id: 'delete-1',
      type: 'deletion',
      from: 7,
      to: 11,
      originalText: 'beta',
      suggestedText: '',
      author: 'claude',
      createdAt: '2026-07-11T18:04:00Z',
      status: 'pending',
    },
    {
      id: 'replace-delete',
      pairId: 'replace-1',
      type: 'deletion',
      from: 12,
      to: 17,
      originalText: 'gamma',
      suggestedText: '',
      author: 'claude',
      createdAt: '2026-07-11T18:05:00Z',
      status: 'pending',
    },
    {
      id: 'replace-insert',
      pairId: 'replace-1',
      type: 'insertion',
      from: 18,
      to: 23,
      originalText: '',
      suggestedText: 'delta',
      author: 'claude',
      createdAt: '2026-07-11T18:05:00Z',
      status: 'pending',
    },
    {
      id: 'format-1',
      type: 'format',
      author: 'claude',
      createdAt: '2026-07-11T18:06:00Z',
      status: 'pending',
      segments: [{ from: 24, to: 31, text: 'epsilon', adds: ['bold'], removes: [] }],
    },
  ],
});

async function openAuditDocument(page: Page) {
  await setupMemoryTauri(page, {
    openPath: DOC_PATH,
    files: { [DOC_PATH]: DOC, [SIDECAR_PATH]: sidecar },
    trustedSidecarPaths: [DOC_PATH],
  });
  await openMemoryFile(page);
}

async function expectType(
  locator: Locator,
  size: string,
  { checkUiFamily = true }: { checkUiFamily?: boolean } = {},
) {
  await expect(locator).toBeVisible();
  const style = await locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    const primaryFamily = (familyStack: string) =>
      familyStack
        .split(',')[0]
        .trim()
        .replace(/^['"]|['"]$/g, '');
    const uiFamily = primaryFamily(
      getComputedStyle(document.documentElement).getPropertyValue('--font-sans'),
    );
    return {
      fontSize: computed.fontSize,
      fontFamily: primaryFamily(computed.fontFamily),
      uiFamily,
    };
  });
  expect(style.fontSize).toBe(size);
  if (checkUiFamily) {
    expect(style.uiFamily).not.toBe('');
    expect(style.fontFamily).toBe(style.uiFamily);
  }
}

async function expectVerticallyContained(locator: Locator) {
  const result = await locator.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      const textBoxes = Array.from(element.childNodes)
        .filter(
          (node): node is Text => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim(),
        )
        .map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect();
        });
      return {
        className: element.className,
        text: element.textContent?.trim(),
        box: { top: box.top, bottom: box.bottom },
        textBoxes: textBoxes.map((text) => ({ top: text.top, bottom: text.bottom })),
        fits: textBoxes.every((text) => text.top >= box.top - 1 && text.bottom <= box.bottom + 1),
      };
    }),
  );
  expect(result.filter((entry) => !entry.fits)).toEqual([]);
}

async function expectVisibleControlsUseUiFamily(page: Page) {
  const mismatches = await page
    .locator('button:visible, input:visible, textarea:visible, select:visible')
    .evaluateAll((elements) => {
      const primaryFamily = (familyStack: string) =>
        familyStack
          .split(',')[0]
          .trim()
          .replace(/^['"]|['"]$/g, '');
      const uiFamily = primaryFamily(
        getComputedStyle(document.documentElement).getPropertyValue('--font-sans'),
      );
      return elements
        .filter(
          (element) =>
            !element.closest('.footer') &&
            !element.matches('.rail-btn.italic, .rail-btn.quote, .rail-btn.code'),
        )
        .map((element) => ({
          element: `${element.tagName.toLowerCase()}.${element.className}`,
          family: primaryFamily(getComputedStyle(element).fontFamily),
          uiFamily,
        }))
        .filter(({ family, uiFamily: expected }) => family !== expected);
    });
  expect(mismatches).toEqual([]);
}

test('document typography stays pinned while both themes keep chrome vertically contained', async ({
  page,
}) => {
  await openAuditDocument(page);

  await expectType(activeTabHost(page).locator('.editor-scroll-area'), '18px');
  await expectType(activeEditor(page), '18px', { checkUiFamily: false });
  await expectType(page.locator('.rail-btn').first(), '13px');
  await expectType(page.locator('.mode-switch .seg').first(), '12px');
  await expect(
    page.locator(
      '.editor-scroll-area button, .editor-scroll-area input, .editor-scroll-area textarea, .editor-scroll-area select',
    ),
  ).toHaveCount(0);
  await expectVisibleControlsUseUiFamily(page);

  const themes = ['paper', 'gruvbox'];
  for (const theme of themes) {
    if (theme !== 'paper') {
      await page.locator('.rail .theme-toggle').click();
    }
    await expectType(activeEditor(page), '18px', { checkUiFamily: false });
    await expectVerticallyContained(page.locator('.rail button:visible'));
    await expectVerticallyContained(page.locator('.topbar button:visible'));
    await expectVerticallyContained(page.locator('.footer button:visible, .footer select:visible'));
    await expectVerticallyContained(page.locator('.comment-layer button:visible'));
  }

  await page.emulateMedia({ media: 'print' });
  await expectType(activeEditor(page), '18px', { checkUiFamily: false });
  await expect(page.locator('.footer')).toHaveCSS('display', 'none');
  await page.emulateMedia({ media: 'screen' });
});

test('document chat uses the intended control and metadata scale', async ({ page }) => {
  await openAuditDocument(page);
  const tab = activeTabHost(page);
  await tab.getByRole('tab', { name: 'Chat', exact: true }).click();

  const composer = tab.getByLabel('Ask Claude about this document');
  await expectType(composer, '12.5px');
  expect(
    await composer.evaluate((element) => getComputedStyle(element, '::placeholder').fontSize),
  ).toBe('12.5px');
  await expectType(tab.locator('.panel-tab').first(), '12px');
  await expectType(tab.locator('.panel-session-chip'), '10px', { checkUiFamily: false });
  await expectType(tab.locator('.chat-box-foot .kbd-hint'), '9px', {
    checkUiFamily: false,
  });
  await expectVisibleControlsUseUiFamily(page);
});

test('form controls and every review-card kind use the intended UI scale and family', async ({
  page,
}) => {
  await openAuditDocument(page);

  await expectType(page.locator('.comment-thread-title').first(), '12px');
  await expectType(page.locator('.comment-time').first(), '11px');
  await expectType(page.locator('.comment-anchor-text').first(), '12px', {
    checkUiFamily: false,
  });
  await expectType(page.locator('.comment-reply-claude').first(), '12px');
  await expectType(page.locator('.comment-reply-text').first(), '12.5px');
  await expectType(page.locator('.suggestion-ai-badge').first(), '8.5px', {
    checkUiFamily: false,
  });
  await expectType(page.locator('.suggestion-type-badge.insert'), '10px');
  await expectType(page.locator('.suggestion-type-badge.delete'), '10px');
  await expectType(page.locator('.suggestion-type-badge.replace'), '10px');
  await expectType(page.locator('.suggestion-type-badge.format'), '10px');
  await expectType(page.locator('.formatting-change-description'), '12px');
  await expectType(page.locator('.suggestion-accept-btn').first(), '12px');

  await expectType(page.locator('.comment-reply-trigger'), '12px');
  await page.locator('.comment-reply-trigger').click();
  await expectType(page.locator('.comment-reply-input'), '13px');

  await page.keyboard.press('ControlOrMeta+f');
  await expectType(page.locator('.find-bar-input').first(), '13px');
  await expectType(page.locator('.find-bar-btn-text').first(), '12px');
  await page.locator('.find-bar-btn[title="Close (Esc)"]').click();

  const editor = activeEditor(page);
  await editor.click();
  await selectLastCharacters(page, 4);
  await page.keyboard.press('ControlOrMeta+k');
  await expectType(page.locator('#link-editor-text'), '14px', { checkUiFamily: false });
  await expectType(page.locator('#link-editor-url'), '12.5px', { checkUiFamily: false });
  await expectType(page.locator('.link-editor-btn').first(), '12.5px', {
    checkUiFamily: false,
  });
  await page.keyboard.press('Escape');

  await expect(page.locator('.add-comment-btn')).toBeVisible();
  await page.locator('.add-comment-btn').click();
  await expectType(page.locator('.add-comment-compose .comment-reply-input'), '12.5px');

  await expectType(page.locator('.footer-zoom-label'), '10px', { checkUiFamily: false });
  await expectType(page.getByLabel('Claude model'), '10px', { checkUiFamily: false });
  await expectType(page.locator('.footer-context-binding'), '10px', {
    checkUiFamily: false,
  });
  await expectVisibleControlsUseUiFamily(page);
});

test('session picker body text and controls inherit the app font', async ({ page }) => {
  await openAuditDocument(page);
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__ as {
      invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    };
    const original = internals.invoke.bind(internals);
    internals.invoke = async (cmd, args) => {
      if (cmd === 'list_claude_sessions') {
        return [
          {
            sessionId: 'session-a',
            jsonlPath: '/tmp/session-a.jsonl',
            cwd: '/tmp/project',
            title: 'Typography audit',
            lastUsed: Date.now() / 1000,
          },
        ];
      }
      if (cmd === 'read_claude_session_preview') {
        return {
          sessionId: 'session-a',
          cwd: '/tmp/project',
          recentAssistantMessages: ['A readable assistant preview.'],
        };
      }
      return original(cmd, args);
    };
  });
  await page.locator('.footer-ai-binding-label').click();

  await expectType(page.locator('.session-picker-header'), '13px');
  await expectType(page.locator('.session-row'), '13px');
  await expectType(page.locator('.session-row-title'), '13px');
  await expectType(page.locator('.session-row-meta'), '11px');
  await page.locator('.session-row').click();
  await expectType(page.locator('.session-preview-msg'), '13px');
  await expectType(page.locator('.session-picker-preview-meta'), '12.5px');
  await expectType(page.locator('.session-picker-footer .btn-primary'), '12.5px');
  await expectVisibleControlsUseUiFamily(page);
});

test('app modal and update banner chrome use the intended scale', async ({ page }) => {
  await setupMemoryTauri(page);
  await activeEditor(page).fill('dirty');
  await page.locator('.document-tab.active .document-tab-close').click();
  // Modal chrome: assert the title's RENDERED size via role (module classes are
  // hashed). The message size and modal button size are asserted from the module
  // source / global primitives in the unit type-scale suite.
  await expectType(
    page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('heading'),
    '15px',
  );

  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await page.evaluate(() => {
    const banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.dataset.typeAudit = 'true';
    banner.innerHTML =
      '<span>Quill <strong>9.9.9</strong> is available.</span><button class="update-banner-link">View release</button><button class="update-banner-dismiss">×</button>';
    document.querySelector('.app')?.prepend(banner);
  });
  await expectType(page.locator('[data-type-audit="true"]'), '13px');
  await expectType(page.locator('[data-type-audit="true"] .update-banner-link'), '13px');
  await expectVisibleControlsUseUiFamily(page);
});
