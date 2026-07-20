import { describe, it, expect } from 'vitest';
import { structuralOpLabel } from '../../components/StructuralCard';

/**
 * V1b: the review card must not erase WHICH list kind is being proposed — a reviewer
 * needs to see bulleted vs numbered vs checklist to decide. Guards the per-kind labels
 * against a regression that collapses them back to a generic "List".
 */
describe('structuralOpLabel', () => {
  it('labels heading↔paragraph with the level', () => {
    expect(structuralOpLabel({ kind: 'headingToParagraph', level: 2 })).toBe(
      'Heading 2 → Paragraph',
    );
    expect(structuralOpLabel({ kind: 'paragraphToHeading', level: 3 })).toBe(
      'Paragraph → Heading 3',
    );
  });

  it('preserves the list KIND in both directions', () => {
    expect(structuralOpLabel({ kind: 'paragraphToList', listType: 'bulletList' })).toBe(
      'Paragraph → Bulleted list',
    );
    expect(structuralOpLabel({ kind: 'paragraphToList', listType: 'orderedList' })).toBe(
      'Paragraph → Numbered list',
    );
    expect(structuralOpLabel({ kind: 'paragraphToList', listType: 'taskList' })).toBe(
      'Paragraph → Checklist',
    );
    expect(structuralOpLabel({ kind: 'listToParagraph', listType: 'bulletList' })).toBe(
      'Bulleted list → Paragraph',
    );
    expect(structuralOpLabel({ kind: 'listToParagraph', listType: 'orderedList' })).toBe(
      'Numbered list → Paragraph',
    );
    expect(structuralOpLabel({ kind: 'listToParagraph', listType: 'taskList' })).toBe(
      'Checklist → Paragraph',
    );
  });
});
