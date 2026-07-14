import { expect, test, type Page } from '@playwright/test';
import { activeTabHost, openMemoryFile, setupMemoryTauri } from './helpers/memoryTauri';

const DOC_PATH = '/tmp/comment-history.md';
const SIDECAR_PATH = '/tmp/comment-history.comments.json';

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
  resolved: boolean,
  replies: Array<Record<string, unknown>> = [],
) {
  return {
    id,
    anchorText: range.text,
    from: range.from,
    to: range.to,
    author: 'Reviewer',
    createdAt: `2026-07-12T18:${id.padStart(2, '0')}:00Z`,
    resolved,
    replies,
  };
}

function sidecar(comments: unknown[], suggestions: unknown[] = []) {
  return JSON.stringify({ version: 2, comments, suggestions });
}

async function openReviewFile(
  page: Page,
  paragraphs: string[],
  comments: unknown[],
  suggestions: unknown[] = [],
) {
  await setupMemoryTauri(page, {
    openPath: DOC_PATH,
    files: {
      [DOC_PATH]: paragraphs.join('\n\n'),
      [SIDECAR_PATH]: sidecar(comments, suggestions),
    },
  });
  await openMemoryFile(page);
}

test('All is a document-ordered history list with independent scrolling; Open stays synced', async ({
  page,
}) => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, index) => `Paragraph ${index} has enough prose to make the document comfortably tall.`,
  );
  const ranges = paragraphRanges(paragraphs);
  const indexes = [2, 5, 9, 13, 18, 23, 29, 35];
  const comments = indexes
    .map((index, order) =>
      comment(String(order), ranges[index], order % 2 === 0, [
        {
          id: `reply-${order}`,
          author: 'Reviewer',
          text: 'A reply that gives this history card enough height to exercise panel scrolling.',
          createdAt: '2026-07-12T19:00:00Z',
          authorKind: 'user',
        },
      ]),
    )
    .reverse();
  await openReviewFile(page, paragraphs, comments);

  const activeTab = activeTabHost(page);
  await activeTab.locator('.comments-head .filter').click();
  const history = activeTab.locator('.comment-history-list');
  await expect(history).toBeVisible();
  await expect(page.locator('.comment-card')).toHaveCount(comments.length);
  await expect(page.locator('.offscreen-pill')).toHaveCount(0);
  await expect(activeTab.locator('.comment-layer-scroll')).toHaveCount(0);
  await expect(activeTab.locator('.editor-bottom-spacer')).toHaveCount(0);
  expect(
    await page
      .locator('.comment-card')
      .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.cardId)),
  ).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);

  const editorScroll = activeTab.locator('.editor-scroll-area');
  const editorBefore = await editorScroll.evaluate((element) => element.scrollTop);
  await history.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await editorScroll.evaluate((element) => element.scrollTop)).toBe(editorBefore);
  await expect(page.locator('.comment-card')).toHaveCount(comments.length);

  await activeTab.locator('.comments-head .filter').click();
  await expect(history).toHaveCount(0);
  await expect(activeTab.locator('.comment-layer-scroll')).toBeVisible();
  await editorScroll.evaluate((element) => {
    element.scrollTop = 900;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect
    .poll(() => activeTab.locator('.comment-layer-scroll').getAttribute('style'))
    .toContain('translateY(-900px)');
});

test('View suggestion from All switches to Open before focusing the existing suggestion', async ({
  page,
}) => {
  const paragraphs = ['hello world'];
  const [range] = paragraphRanges(paragraphs);
  const origin = comment('1', { ...range, text: 'hello', to: 6 }, true, [
    {
      id: 'ai-reply',
      author: 'Claude',
      text: 'I proposed the linked edit.',
      createdAt: '2026-07-12T19:00:00Z',
      authorKind: 'ai',
      suggestionIds: ['linked-insert'],
    },
  ]);
  const suggestion = {
    id: 'linked-insert',
    type: 'insertion',
    from: 7,
    to: 12,
    originalText: '',
    suggestedText: 'world',
    author: 'claude',
    createdAt: '2026-07-12T19:00:00Z',
    status: 'pending',
    originCommentId: origin.id,
  };
  await openReviewFile(page, paragraphs, [origin], [suggestion]);

  const activeTab = activeTabHost(page);
  await activeTab.locator('.comments-head .filter').click();
  await expect(activeTab.locator('.comment-history-list')).toBeVisible();
  await expect(page.locator('.suggestion-card')).toHaveCount(0);
  await page.getByRole('button', { name: /View suggestion/i }).click();

  await expect(activeTab.locator('.comments-head .filter')).toContainText('Open');
  await expect(page.locator('.comment-history-list')).toHaveCount(0);
  await expect(page.locator('.suggestion-card-active')).toBeVisible();
});

test('resolved comments jump only to safely located text and unresolve never stamps ambiguity', async ({
  page,
}) => {
  const paragraphs = Array.from({ length: 24 }, (_, index) => `Filler paragraph ${index}.`);
  paragraphs[2] = 'repeated anchor';
  paragraphs[12] = 'stored offset now points here';
  paragraphs[21] = 'repeated anchor';
  const ranges = paragraphRanges(paragraphs);
  const stale = comment('1', ranges[12], true);
  stale.anchorText = 'repeated anchor';
  await openReviewFile(page, paragraphs, [stale]);

  const activeTab = activeTabHost(page);
  await activeTab.locator('.comments-head .filter').click();
  const editorScroll = activeTab.locator('.editor-scroll-area');
  await editorScroll.evaluate((element) => {
    element.scrollTop = 300;
  });
  const beforeClick = await editorScroll.evaluate((element) => element.scrollTop);
  await page.locator('.comment-card').click();
  await expect
    .poll(() =>
      editorScroll.evaluate(
        (element) =>
          new Promise<{ first: number; settled: number }>((resolve) => {
            const first = element.scrollTop;
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve({ first, settled: element.scrollTop })),
            );
          }),
      ),
    )
    .toEqual({ first: beforeClick, settled: beforeClick });

  await page.getByTitle('Unresolve').click();
  await expect(page.locator('.comment-card-resolved')).toBeVisible();
  await expect(page.locator('.comment-inline-notice')).toContainText('remains resolved');
  await expect(page.locator('mark[data-comment-id="1"]')).toHaveCount(0);
});

test('Unresolve reattaches a uniquely moved anchor instead of its stale stored offset', async ({
  page,
}) => {
  const paragraphs = Array.from({ length: 20 }, (_, index) => `Filler paragraph ${index}.`);
  paragraphs[16] = 'unique moved anchor';
  const ranges = paragraphRanges(paragraphs);
  const stale = comment('1', ranges[5], true);
  stale.anchorText = 'unique moved anchor';
  await openReviewFile(page, paragraphs, [stale]);

  const activeTab = activeTabHost(page);
  await activeTab.locator('.comments-head .filter').click();
  const editorScroll = activeTab.locator('.editor-scroll-area');
  await page.locator('.comment-card').click();
  await expect.poll(() => editorScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByTitle('Unresolve').click();

  await expect(page.locator('.comment-card-resolved')).toHaveCount(0);
  await expect(page.locator('mark[data-comment-id="1"]')).toHaveText('unique moved anchor');
  await expect(page.locator('.comment-inline-notice')).toHaveCount(0);
  await expect(activeTab.locator('.comments-head .filter')).toBeEnabled();
});
