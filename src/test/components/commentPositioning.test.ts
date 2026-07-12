import { describe, expect, it } from 'vitest';
import { layoutAnchoredCards, type AnchoredCardInput } from '../../components/commentPositioning';

function card(
  cardId: string,
  anchorTop: number,
  height = 80,
  documentOrder = anchorTop,
): AnchoredCardInput {
  return { cardId, anchorTop, height, documentOrder };
}

const viewport = {
  viewportTop: 0,
  viewportBottom: 500,
  activeCardId: null,
  gap: 12,
};

describe('layoutAnchoredCards', () => {
  it('aligns the first card and cascades collisions downward with a 12px gap', () => {
    const layout = layoutAnchoredCards(
      [card('first', 40), card('second', 70), card('third', 90)],
      viewport,
    );

    expect(layout.positions.map(({ cardId, top }) => ({ cardId, top }))).toEqual([
      { cardId: 'first', top: 40 },
      { cardId: 'second', top: 132 },
      { cardId: 'third', top: 224 },
    ]);
  });

  it('keeps an active card exact and reflows neighbors around it without reordering', () => {
    const layout = layoutAnchoredCards(
      [card('first', 100), card('active', 130), card('third', 150)],
      { ...viewport, activeCardId: 'active' },
    );

    expect(layout.positions.map(({ cardId, top }) => ({ cardId, top }))).toEqual([
      { cardId: 'first', top: 38 },
      { cardId: 'active', top: 130 },
      { cardId: 'third', top: 222 },
    ]);
  });

  it('keeps stable document order when anchors share a line', () => {
    const layout = layoutAnchoredCards(
      [card('later', 100, 40, 2), card('earlier', 100, 40, 1)],
      viewport,
    );

    expect(layout.positions.map(({ cardId, top }) => ({ cardId, top }))).toEqual([
      { cardId: 'earlier', top: 100 },
      { cardId: 'later', top: 152 },
    ]);
  });

  it('collapses off-screen anchors into ordered above and below lists', () => {
    const layout = layoutAnchoredCards(
      [card('far-above', 10), card('near-above', 90), card('visible', 140), card('below', 420)],
      { ...viewport, viewportTop: 100, viewportBottom: 400 },
    );

    expect(layout.positions.map((entry) => entry.cardId)).toEqual(['visible']);
    expect(layout.above).toEqual(['far-above', 'near-above']);
    expect(layout.below).toEqual(['below']);
    expect(layout.above.at(-1)).toBe('near-above');
    expect(layout.below[0]).toBe('below');
  });

  it('keeps visible anchors while clamping their cards clear of panel chrome', () => {
    const layout = layoutAnchoredCards([card('near-top', 8), card('near-bottom', 480)], {
      ...viewport,
      cardViewportTop: 44,
      cardViewportBottom: 438,
    });

    expect(layout.above).toEqual([]);
    expect(layout.below).toEqual([]);
    expect(layout.positions.map(({ cardId, top }) => ({ cardId, top }))).toEqual([
      { cardId: 'near-top', top: 44 },
      { cardId: 'near-bottom', top: 358 },
    ]);
  });

  it('returns only pinned counts when no anchors are in the viewport', () => {
    expect(
      layoutAnchoredCards([card('above', 20), card('below', 600)], {
        ...viewport,
        viewportTop: 100,
        viewportBottom: 500,
      }),
    ).toEqual({ positions: [], above: ['above'], below: ['below'] });
  });
});
