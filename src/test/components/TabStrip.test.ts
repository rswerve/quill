import { describe, expect, it } from 'vitest';
import { collapsedTabIds, type TabStripItem } from '../../components/TabStrip';

function tabs(count: number): TabStripItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tab-${index + 1}`,
    title: `Document ${index + 1}.md`,
    isDirty: false,
  }));
}

describe('collapsedTabIds', () => {
  it('keeps every tab visible while their floor widths fit', () => {
    expect(collapsedTabIds(tabs(3), 'tab-1', 500)).toEqual(['tab-1', 'tab-2', 'tab-3']);
  });

  it('uses a bounded window that always includes the active tab', () => {
    expect(collapsedTabIds(tabs(8), 'tab-6', 500)).toEqual(['tab-4', 'tab-5', 'tab-6']);
  });

  it('keeps the active tab visible even at the narrowest width', () => {
    expect(collapsedTabIds(tabs(5), 'tab-4', 100)).toEqual(['tab-4']);
  });
});
