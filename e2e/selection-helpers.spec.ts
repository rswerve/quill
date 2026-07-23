/**
 * Pins the position arithmetic behind the shared selection helpers.
 *
 * These helpers set ProseMirror selections directly, and their maths was wrong
 * in six distinct ways during review: treating positions as characters,
 * anchoring past a trailing empty paragraph, sweeping a trailing inline image
 * into the range, matching a needle that straddled an atom, bridging a block
 * boundary that had an image beside it, and bridging straight through a
 * paragraph containing nothing but an image. None were caught by the suite,
 * because no ordinary test puts an image beside the text it selects.
 *
 * Deliberately ONE browser test with steps rather than one test per case. Every
 * browser test pays a fixed app boot — over half this suite's total time — and
 * paying that fourteen times to check test-only arithmetic would undo the cost
 * this branch exists to reduce.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import type { Editor, JSONContent } from '@tiptap/react';
import { activeEditor, selectEditorText, selectLastCharacters } from './helpers/memoryTauri';

type Doc = JSONContent & { type: 'doc'; content: JSONContent[] };

const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const textNode = (value: string, marks?: string[]): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
});
const image = (): JSONContent => ({ type: 'image', attrs: { src: 'x.png' } });
const doc = (...content: JSONContent[]): Doc => ({ type: 'doc', content });

/**
 * Documents are built as ProseMirror JSON. `setContent` parses a STRING as
 * Markdown here (tiptap-markdown), so HTML markup would arrive as literal text.
 */
async function load(page: Page, content: Doc) {
  await page.evaluate((json) => {
    const probe = (window as unknown as { __quillEditor?: Editor }).__quillEditor;
    if (!probe) throw new Error('no editor handle');
    probe.commands.setContent(json);
  }, content);
}

async function selection(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __quillEditor?: Editor }).__quillEditor;
    if (!probe) throw new Error('no editor handle');
    const { from, to } = probe.state.selection;
    return { from, to, selected: probe.state.doc.textBetween(from, to, '\n') };
  });
}

test('selection helper position arithmetic', async ({ page }) => {
  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();

  await test.step('selects the last characters of a single paragraph', async () => {
    await load(page, doc(para(textNode('hello world'))));
    await selectLastCharacters(page, 5);
    expect((await selection(page)).selected).toBe('world');
  });

  await test.step('a count reaching across a paragraph break includes the newline', async () => {
    // The separator is one character of text but two positions.
    await load(page, doc(para(textNode('abc')), para(textNode('def'))));
    await selectLastCharacters(page, 4);
    expect((await selection(page)).selected).toBe('\ndef');
  });

  await test.step('a trailing empty paragraph does not consume part of the count', async () => {
    await load(page, doc(para(textNode('hello world')), para()));
    await selectLastCharacters(page, 5);
    expect((await selection(page)).selected).toBe('world');
  });

  await test.step('a trailing inline image is not swept in', async () => {
    await load(page, doc(para(textNode('foo'), image())));
    await selectLastCharacters(page, 3);
    const result = await selection(page);
    expect(result.selected).toBe('foo');
    expect(result.to).toBe(4); // 5 would be past the image
  });

  await test.step('a leading inline image does not shift text positions', async () => {
    await load(page, doc(para(image(), textNode('foo'))));
    await selectEditorText(page, 'foo');
    expect((await selection(page)).selected).toBe('foo');
  });

  await test.step('a needle straddling an image is refused', async () => {
    await load(page, doc(para(textNode('foo'), image(), textNode('bar'))));
    await expect(selectEditorText(page, 'foobar')).rejects.toThrow(/contiguous run/);
  });

  await test.step('text split by marks is one selectable run', async () => {
    await load(page, doc(para(textNode('al'), textNode('pha', ['bold']), textNode(' beta'))));
    await selectEditorText(page, 'alpha');
    expect((await selection(page)).selected).toBe('alpha');
  });

  await test.step('the first occurrence is chosen deterministically', async () => {
    await load(page, doc(para(textNode('one two one'))));
    await selectEditorText(page, 'one');
    expect((await selection(page)).from).toBe(1);
  });

  await test.step('a needle containing a newline does not span blocks', async () => {
    await load(page, doc(para(textNode('abc')), para(textNode('def'))));
    await expect(selectEditorText(page, 'abc\ndef')).rejects.toThrow(/contiguous run/);
  });

  await test.step('a block boundary beside an image is not a bare newline', async () => {
    await load(page, doc(para(textNode('foo'), image()), para(textNode('bar'))));
    await expect(selectLastCharacters(page, 5)).rejects.toThrow(/contiguous characters/);
  });

  await test.step('a paragraph holding only an image blocks the bridge', async () => {
    await load(page, doc(para(textNode('foo')), para(image()), para(textNode('bar'))));
    await expect(selectLastCharacters(page, 5)).rejects.toThrow(/contiguous characters/);
  });

  await test.step('an empty needle is rejected', async () => {
    await load(page, doc(para(textNode('hello'))));
    await expect(selectEditorText(page, '')).rejects.toThrow(/must not be empty/);
  });

  await test.step('a non-positive count is rejected', async () => {
    await load(page, doc(para(textNode('hello'))));
    await expect(selectLastCharacters(page, 0)).rejects.toThrow(/positive integer/);
  });

  await test.step('a count longer than the document is refused', async () => {
    await load(page, doc(para(textNode('hi'))));
    await expect(selectLastCharacters(page, 50)).rejects.toThrow(/contiguous characters/);
  });
});
