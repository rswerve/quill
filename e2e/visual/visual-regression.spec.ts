import { expect, test, type Locator, type Page } from '@playwright/test';
import { activeEditor, activeTabHost, setupMemoryTauri } from '../helpers/memoryTauri';

type Theme = 'paper' | 'gruvbox';

const DOC_PATH = '/tmp/quill-visual.md';
const SIDECAR_PATH = '/tmp/quill-visual.comments.json';
const FIXED_NOW = new Date('2026-07-14T17:00:00-05:00');

const RICH_MARKDOWN = `# Design review

Quill keeps **bold decisions**, _careful nuance_, ~~retired language~~, and \`inline code\` readable.

## Review checklist

- Keep the Markdown portable
- Review every proposed change
- [Open the project notes](https://example.com/notes)

> The document remains the source of truth.

| Surface | Status |
| --- | --- |
| Comments | Ready |
| Suggestions | Review |
`;

interface ParagraphRange {
  text: string;
  from: number;
  to: number;
}

function paragraphRanges(paragraphs: string[]): ParagraphRange[] {
  let from = 1;
  return paragraphs.map((text) => {
    const range = { text, from, to: from + text.length };
    from += text.length + 2;
    return range;
  });
}

function comment(
  id: string,
  range: ParagraphRange,
  options: {
    kind?: 'note' | 'claude';
    resolved?: boolean;
    body?: string;
    replies?: Array<Record<string, unknown>>;
  } = {},
) {
  return {
    id,
    kind: options.kind ?? 'note',
    anchorText: range.text,
    from: range.from,
    to: range.to,
    author: 'Author',
    createdAt: '2026-07-14T16:30:00.000Z',
    resolved: options.resolved ?? false,
    replies: [
      {
        id: `${id}-opening`,
        author: 'Author',
        text: options.body ?? 'Keep this thought for the next revision.',
        createdAt: '2026-07-14T16:30:00.000Z',
        authorKind: 'user',
      },
      ...(options.replies ?? []),
    ],
  };
}

function sidecar(
  options: {
    comments?: unknown[];
    suggestions?: unknown[];
    aiSession?: Record<string, unknown>;
    chat?: Record<string, unknown>;
  } = {},
) {
  return JSON.stringify({
    version: 2,
    comments: options.comments ?? [],
    suggestions: options.suggestions ?? [],
    ...(options.aiSession ? { aiSession: options.aiSession } : {}),
    ...(options.chat ? { chat: options.chat } : {}),
  });
}

async function settleVisual(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function setupVisual(
  page: Page,
  theme: Theme,
  options: Parameters<typeof setupMemoryTauri>[1] = {},
): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('quill-theme', selectedTheme);
    let randomState = 0x7151_2026;
    Math.random = () => {
      randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    let uuidSequence = 0;
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
    });
  }, theme);
  await setupMemoryTauri(page, options);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await settleVisual(page);
}

async function mountUpdateBannerHarness(page: Page): Promise<Locator> {
  await page.evaluate(async () => {
    let host = document.querySelector<HTMLElement>('[data-update-visual-host]');
    if (!host) {
      host = document.createElement('div');
      host.dataset.updateVisualHost = 'true';
      // Match UpdateBanner's real placement inside .studio-main without adding
      // a wrapper box that changes its width or vertical rhythm.
      host.style.display = 'contents';
      document.querySelector('.studio-main')?.prepend(host);
    }
    const module = await import('/e2e/helpers/updateNotificationHarness.tsx');
    module.mountUpdateNotificationHarness(host);
  });
  return page.locator('[data-update-visual-host]').getByRole('status');
}

async function openVisualDocument(
  page: Page,
  theme: Theme,
  markdown: string,
  reviewSidecar = sidecar(),
  extraOptions: Parameters<typeof setupMemoryTauri>[1] = {},
): Promise<void> {
  await setupVisual(page, theme, {
    ...extraOptions,
    openPath: DOC_PATH,
    files: {
      ...(extraOptions.files ?? {}),
      [DOC_PATH]: markdown,
      [SIDECAR_PATH]: reviewSidecar,
    },
  });
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __quillListeners?: Array<{ event: string }>;
      }
    ).__quillListeners?.some((listener) => listener.event === 'menu-open'),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.crumbs .cur')).not.toHaveText('Untitled');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  // A session-linked fixture surfaces the (expected) session picker — which is
  // itself a role="dialog" — so dismiss it BEFORE the unexpected-dialog guard,
  // otherwise the guard would flag the picker as a notice.
  const picker = page.getByRole('dialog', { name: 'Link Claude Code session' });
  if (await picker.count()) await picker.getByRole('button', { name: 'Close' }).click();
  // Any REMAINING dialog is an unexpected application notice — fail loudly.
  const notice = page.getByRole('dialog');
  if (await notice.count()) {
    const restoredCardClasses = await page
      .locator('.suggestion-card')
      .evaluateAll((cards) => cards.map((card) => card.className));
    throw new Error(
      `Visual fixture triggered an application notice: ${await notice.innerText()}\nRestored cards: ${restoredCardClasses.join(', ')}`,
    );
  }
  await settleVisual(page);
}

async function selectText(page: Page, needle: string, occurrence = 0): Promise<void> {
  await activeEditor(page).evaluate(
    (root, target) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number; end: number }> = [];
      let fullText = '';
      let current: Node | null;
      while ((current = walker.nextNode())) {
        const node = current as Text;
        nodes.push({ node, start: fullText.length, end: fullText.length + node.data.length });
        fullText += node.data;
      }
      let start = -1;
      let searchFrom = 0;
      for (let index = 0; index <= target.occurrence; index += 1) {
        start = fullText.indexOf(target.needle, searchFrom);
        if (start < 0) throw new Error(`Could not select ${target.needle}`);
        searchFrom = start + target.needle.length;
      }
      const end = start + target.needle.length;
      const first = nodes.find((entry) => start >= entry.start && start < entry.end);
      const last = nodes.find((entry) => end > entry.start && end <= entry.end);
      if (!first || !last) throw new Error(`Selection ${start}..${end} has no text nodes`);
      (root as HTMLElement).focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    },
    { needle, occurrence },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(needle);
}

async function shot(page: Page, theme: Theme, name: string, locator?: Locator): Promise<void> {
  await settleVisual(page);
  const target = locator ?? page;
  await expect(target).toHaveScreenshot(`${theme}-${name}.png`, {
    animations: 'disabled',
    caret: 'hide',
  });
}

function reviewFixture() {
  const paragraphs = [
    'Inserted sentence.',
    'Deleted sentence.',
    'Replace this wording.',
    'Formatted phrase.',
    'Stable context for the review.',
  ];
  const ranges = paragraphRanges(paragraphs);
  return {
    markdown: paragraphs.join('\n\n'),
    sidecar: sidecar({
      suggestions: [
        {
          id: 'visual-insert',
          type: 'change',
          author: 'user',
          createdAt: '2026-07-14T16:20:00.000Z',
          status: 'pending',
          segments: [{ kind: 'insert', ...ranges[0] }],
        },
        {
          id: 'visual-delete',
          type: 'change',
          author: 'claude',
          createdAt: '2026-07-14T16:21:00.000Z',
          status: 'pending',
          segments: [{ kind: 'delete', ...ranges[1] }],
        },
        {
          id: 'visual-format',
          type: 'change',
          author: 'claude',
          createdAt: '2026-07-14T16:23:00.000Z',
          status: 'pending',
          segments: [{ kind: 'format', ...ranges[3], adds: ['bold'], removes: [] }],
        },
      ],
    }),
  };
}

test.describe('visual regression safety net', () => {
  test.describe.configure({ mode: 'serial' });

  for (const theme of ['paper', 'gruvbox'] as const) {
    test.describe(theme, () => {
      test('empty document', async ({ page }) => {
        await setupVisual(page, theme);
        await expect(page.locator('.editor-empty-state')).toBeVisible();
        await shot(page, theme, 'empty-document');
      });

      test('rich Markdown page', async ({ page }) => {
        await openVisualDocument(page, theme, RICH_MARKDOWN);
        await expect(activeEditor(page).locator('table')).toBeVisible();
        await shot(page, theme, 'rich-page');
      });

      test('complete application shell', async ({ page }) => {
        const paragraphs = [
          'The complete shell fixture keeps every application region visible.',
          'A private note gives the review panel real content.',
          'A Claude thread shows the second margin-object identity.',
          'The final paragraph keeps the document comfortably populated.',
        ];
        const ranges = paragraphRanges(paragraphs);
        const comments = [
          comment('shell-note', ranges[1], {
            body: 'Keep this supporting detail available during revision.',
          }),
          comment('shell-claude', ranges[2], {
            kind: 'claude',
            body: 'Can you make this claim more concrete?',
            replies: [
              {
                id: 'shell-claude-answer',
                author: 'Claude',
                text: 'I would name the exact outcome and remove the abstract qualifier.',
                createdAt: '2026-07-14T16:36:00.000Z',
                authorKind: 'ai',
                model: 'claude-sonnet',
              },
            ],
          }),
        ];
        await openVisualDocument(page, theme, paragraphs.join('\n\n'), sidecar({ comments }));

        const shell = page.locator('.app');
        await expect(shell).toBeVisible();
        await expect(page.locator('.rail')).toBeVisible();
        await expect(page.locator('.topbar')).toBeVisible();
        await expect(page.locator('.tabstrip')).toBeVisible();
        await expect(activeEditor(page)).toContainText('complete shell fixture');
        await expect(activeTabHost(page).locator('.comment-card')).toHaveCount(2);
        await expect(page.locator('.footer')).toBeVisible();
        await expect(shell).toHaveCSS(
          'background-color',
          theme === 'paper' ? 'rgb(251, 250, 247)' : 'rgb(40, 40, 40)',
        );
        await shot(page, theme, 'app-shell', shell);
      });

      test('update notification banner', async ({ page }) => {
        await page.route(
          'https://api.github.com/repos/sam-powers/quill/releases/latest',
          async (route) =>
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                tag_name: 'v9.9.9',
                html_url: 'https://github.com/sam-powers/quill/releases/tag/v9.9.9',
              }),
            }),
        );
        await setupVisual(page, theme);
        const banner = await mountUpdateBannerHarness(page);
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('Quill 9.9.9 is available.');
        await expect(banner.getByRole('button', { name: 'View release' })).toBeVisible();
        await expect(
          banner.getByRole('button', { name: 'Dismiss update notification' }),
        ).toBeVisible();
        await shot(page, theme, 'update-banner', banner);
      });

      test('suggesting mode with insertion, deletion, replacement, and format cards', async ({
        page,
      }) => {
        const fixture = reviewFixture();
        await openVisualDocument(page, theme, fixture.markdown, fixture.sidecar);
        await page.locator('.mode-switch').getByRole('button', { name: 'Suggesting' }).click();
        await selectText(page, 'Replace this wording.');
        await page.keyboard.type('Clearer wording.');
        for (const kind of ['insert', 'delete', 'replace', 'format']) {
          await expect(page.locator(`.suggestion-card-${kind}`)).toBeVisible();
        }
        await shot(page, theme, 'suggestion-cards');
      });

      test('open comments list', async ({ page }) => {
        const paragraphs = ['Opening paragraph.', 'Private note anchor.', 'Claude thread anchor.'];
        const ranges = paragraphRanges(paragraphs);
        const comments = [
          comment('note-open', ranges[1], { body: 'Tighten this transition.' }),
          comment('claude-open', ranges[2], {
            kind: 'claude',
            body: 'Can you make this more direct?',
            replies: [
              {
                id: 'claude-answer',
                author: 'Claude',
                text: 'I would lead with the conclusion and trim the qualifier.',
                createdAt: '2026-07-14T16:35:00.000Z',
                authorKind: 'ai',
                model: 'claude-sonnet',
              },
            ],
          }),
        ];
        await openVisualDocument(page, theme, paragraphs.join('\n\n'), sidecar({ comments }));
        await expect(page.locator('.comment-card')).toHaveCount(2);
        await shot(page, theme, 'comments-open');
      });

      test('resolved comments list', async ({ page }) => {
        const paragraphs = ['Resolved note anchor.', 'Resolved thread anchor.'];
        const ranges = paragraphRanges(paragraphs);
        const comments = [
          comment('note-resolved', ranges[0], { resolved: true, body: 'Historical note.' }),
          comment('claude-resolved', ranges[1], {
            kind: 'claude',
            resolved: true,
            body: 'Historical Claude request.',
          }),
        ];
        await openVisualDocument(page, theme, paragraphs.join('\n\n'), sidecar({ comments }));
        const active = activeTabHost(page);
        await active.locator('.comments-head .filter').click();
        await expect(active.locator('.comment-history-list')).toBeVisible();
        await shot(page, theme, 'comments-resolved');
      });

      test('annotation gutter and offscreen counts', async ({ page }) => {
        const paragraphs = Array.from(
          { length: 36 },
          (_, index) => `Paragraph ${index + 1} provides a stable annotation anchor for review.`,
        );
        const ranges = paragraphRanges(paragraphs);
        const comments = [0, 1, 18, 35].map((index) =>
          comment(`gutter-${index}`, ranges[index], {
            kind: index === 18 ? 'claude' : 'note',
            body: `Review paragraph ${index + 1}.`,
          }),
        );
        await openVisualDocument(page, theme, paragraphs.join('\n\n'), sidecar({ comments }));
        const active = activeTabHost(page);
        await expect(active.locator('.annotation-gutter')).toBeVisible();
        await expect(active.locator('.annotation-gutter-count-below')).toBeVisible();
        await shot(page, theme, 'annotation-gutter', active.locator('.studio-body'));
      });

      test('composer with note and Claude cards', async ({ page }) => {
        const paragraphs = ['Private note anchor.', 'Claude thread anchor.', 'New selection.'];
        const ranges = paragraphRanges(paragraphs);
        const comments = [
          comment('composer-note', ranges[0], { body: 'Remember why this wording matters.' }),
          comment('composer-claude', ranges[1], {
            kind: 'claude',
            body: 'Make this easier to scan.',
            replies: [
              {
                id: 'composer-claude-answer',
                author: 'Claude',
                text: 'I can shorten it without losing the claim.',
                createdAt: '2026-07-14T16:38:00.000Z',
                authorKind: 'ai',
              },
            ],
          }),
        ];
        await openVisualDocument(page, theme, paragraphs.join('\n\n'), sidecar({ comments }));
        await selectText(page, 'New selection.');
        await page.locator('.add-comment-btn').click();
        await expect(page.locator('.add-comment-compose')).toBeVisible();
        await page.locator('.add-comment-compose textarea').fill('A new margin thought.');
        const panelList = activeTabHost(page).locator('.comment-panel-list');
        const panelScrollEnd = await panelList.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.scrollHeight - element.clientHeight;
        });
        await expect
          .poll(() => panelList.evaluate((element) => element.scrollTop))
          .toBe(panelScrollEnd);
        await shot(page, theme, 'composer-and-cards');
      });

      test('document chat', async ({ page }) => {
        const session = {
          provider: 'claude-code',
          sessionId: 'visual-session-1234',
          cwd: '/tmp',
          linkedAt: '2026-07-14T16:00:00.000Z',
          createdByQuill: true,
        };
        const chat = {
          sessionId: session.sessionId,
          messages: [
            {
              id: 'chat-user',
              role: 'user',
              text: 'Can you tighten the opening?',
              createdAt: '2026-07-14T16:40:00.000Z',
            },
            {
              id: 'chat-assistant',
              role: 'assistant',
              text: 'Yes. I would lead with the conclusion and remove the throat-clearing.',
              createdAt: '2026-07-14T16:40:02.000Z',
              model: 'claude-sonnet',
            },
          ],
        };
        await openVisualDocument(
          page,
          theme,
          'The opening takes too long to reach the point.',
          sidecar({ aiSession: session, chat }),
        );
        await activeTabHost(page).getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(page.locator('.chat-message')).toHaveCount(2);
        await shot(page, theme, 'document-chat');
      });

      test('session picker', async ({ page }) => {
        const sessions = [
          {
            sessionId: '805faa5a12345678',
            jsonlPath: '/tmp/session-one.jsonl',
            cwd: '/Users/maz/Documents/Quill',
            title: null,
            documentName: 'Research Notes.md',
            lastUsed: FIXED_NOW.getTime() / 1000 - 600,
          },
          {
            sessionId: 'deadbeef12345678',
            jsonlPath: '/tmp/session-two.jsonl',
            cwd: '/Users/maz/Documents/Drafts',
            title: 'Launch draft',
            documentName: null,
            lastUsed: FIXED_NOW.getTime() / 1000 - 3600,
          },
        ];
        await setupVisual(page, theme, {
          claudeSessions: sessions,
          sessionPreviews: {
            '/tmp/session-one.jsonl': {
              sessionId: '805faa5a12345678',
              cwd: '/Users/maz/Documents/Quill',
              recentAssistantMessages: ['I reviewed the introduction and proposed two changes.'],
            },
          },
        });
        await page.locator('.footer-ai-binding-label').click();
        const sessionPicker = page.getByRole('dialog', { name: 'Link Claude Code session' });
        await expect(sessionPicker).toBeVisible();
        await sessionPicker.getByRole('button', { name: 'Research Notes.md' }).click();
        await expect(
          page.getByText('I reviewed the introduction and proposed two changes.'),
        ).toBeVisible();
        await shot(page, theme, 'session-picker', sessionPicker);
      });

      test('find and replace bar', async ({ page }) => {
        await openVisualDocument(
          page,
          theme,
          'Find the first phrase. Then find the second phrase.',
        );
        await activeEditor(page).click();
        await page.keyboard.press('ControlOrMeta+f');
        await page.locator('.find-bar-input').first().fill('find');
        await page.locator('.find-bar-input').nth(1).fill('locate');
        await expect(page.locator('.find-bar-count')).toHaveText('1 of 2');
        await shot(page, theme, 'find-replace', page.locator('.find-bar'));
      });

      test('unsaved changes modal', async ({ page }) => {
        await setupVisual(page, theme);
        await activeEditor(page).fill('Unsaved work that must not be discarded silently.');
        await page.locator('.document-tab.active .document-tab-close').click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await shot(page, theme, 'unsaved-modal', page.getByRole('dialog'));
      });

      test('status footer', async ({ page }) => {
        await openVisualDocument(page, theme, 'One two three four five.');
        await expect(page.locator('.footer')).toContainText('5 WORDS');
        await shot(page, theme, 'status-footer', page.locator('.footer'));
      });

      test('formatting rail', async ({ page }) => {
        await openVisualDocument(page, theme, '**Bold selection** and plain prose.');
        await selectText(page, 'Bold selection');
        await expect(page.locator('.rail-btn.bold')).toHaveClass(/active/);
        await shot(page, theme, 'formatting-rail', page.locator('.rail'));
      });

      test('multi-row tab strip', async ({ page }) => {
        await setupVisual(page, theme);
        for (let index = 0; index < 12; index += 1) {
          await page.locator('.tab-add').click();
        }
        await expect(page.locator('.tab-overflow')).toBeVisible();
        await page.locator('.tab-overflow').click();
        await expect(page.locator('.tabstrip')).toHaveClass(/expanded/);
        await shot(page, theme, 'tab-strip', page.locator('.tabstrip'));
      });

      test('document zoom at 60, 100, and 240 percent', async ({ page }) => {
        await openVisualDocument(
          page,
          theme,
          'Zoom keeps document chrome fixed while prose reflows.',
        );
        for (const zoom of [0.6, 1, 2.4]) {
          if (zoom === 1) await page.locator('.footer-zoom-label').dblclick();
          else await page.locator('.footer-zoom-slider').fill(String(zoom));
          await expect(page.locator('.footer-zoom-label')).toHaveText(`${zoom * 100}%`);
          await shot(page, theme, `zoom-${zoom * 100}`, activeTabHost(page).locator('.workspace'));
        }
      });

      test('link editor', async ({ page }) => {
        await openVisualDocument(page, theme, 'Open the project notes for the full context.');
        await selectText(page, 'project notes');
        await page.keyboard.press('ControlOrMeta+k');
        await expect(page.getByRole('dialog', { name: /Create link|Edit link/ })).toBeVisible();
        await page
          .getByRole('dialog', { name: /Create link|Edit link/ })
          .getByLabel('URL')
          .fill('https://example.com/project-notes');
        await shot(
          page,
          theme,
          'link-editor',
          page.getByRole('dialog', { name: /Create link|Edit link/ }),
        );
      });
    });
  }
});
