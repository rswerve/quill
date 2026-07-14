import { describe, expect, it } from 'vitest';
import {
  layoutGutterTicks,
  nearestGutterTick,
  panelNudgeTarget,
  type GutterTickInput,
} from '../../components/commentPositioning';

function tick(
  cardId: string,
  viewportY: number,
  anchorTop = viewportY,
  documentOrder = viewportY,
): GutterTickInput {
  return {
    cardId,
    targetKind: 'comment',
    annotationKind: 'note',
    anchorTop,
    viewportY,
    documentOrder,
  };
}

describe('layoutGutterTicks', () => {
  it('keeps line-aligned ticks separate at the 14px boundary', () => {
    const layout = layoutGutterTicks([tick('first', 40), tick('second', 54)], 500);

    expect(layout.visible.map((cluster) => cluster.members.map(({ cardId }) => cardId))).toEqual([
      ['first'],
      ['second'],
    ]);
  });

  it('clusters ticks closer than 14px without changing member order', () => {
    const layout = layoutGutterTicks(
      [tick('third', 49, 49, 3), tick('first', 40, 40, 1), tick('second', 46, 46, 2)],
      500,
    );

    expect(layout.visible).toHaveLength(1);
    expect(layout.visible[0].members.map(({ cardId }) => cardId)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(layout.visible[0].viewportY).toBe(45);
  });

  it('classifies off-viewport ticks and exposes the nearest edges', () => {
    const layout = layoutGutterTicks(
      [tick('far-above', -80), tick('near-above', -4), tick('visible', 20), tick('below', 500)],
      500,
    );

    expect(layout.above.map(({ cardId }) => cardId)).toEqual(['far-above', 'near-above']);
    expect(layout.below.map(({ cardId }) => cardId)).toEqual(['below']);
    expect(layout.visible[0].members[0].cardId).toBe('visible');
    expect(layout.above.at(-1)?.cardId).toBe('near-above');
    expect(layout.below[0]?.cardId).toBe('below');
  });
});

describe('nearestGutterTick', () => {
  it('selects the document-space anchor nearest the viewport center', () => {
    const nearest = nearestGutterTick(
      [tick('above', -20, 80, 1), tick('nearest', 90, 190, 2), tick('below', 220, 320, 3)],
      200,
    );
    expect(nearest?.cardId).toBe('nearest');
  });

  it('uses document order as the deterministic distance tie breaker', () => {
    const nearest = nearestGutterTick([tick('later', 0, 90, 2), tick('earlier', 0, 110, 1)], 100);
    expect(nearest?.cardId).toBe('earlier');
  });
});

describe('panelNudgeTarget', () => {
  it('leaves a card inside the middle 60% comfort band alone', () => {
    expect(panelNudgeTarget(100, 500, 220, 120)).toBeNull();
  });

  it('centers a card only after it leaves the comfort band', () => {
    expect(panelNudgeTarget(100, 500, 520, 100)).toBe(320);
    expect(panelNudgeTarget(300, 500, 320, 80)).toBe(110);
  });
});
