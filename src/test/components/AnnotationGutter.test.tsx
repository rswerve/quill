import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AnnotationGutter from '../../components/AnnotationGutter';
import type { GutterTickInput } from '../../components/commentPositioning';

function tick(
  cardId: string,
  annotationKind: 'note' | 'claude',
  viewportY: number,
  documentOrder: number,
): GutterTickInput {
  return {
    cardId,
    targetKind: 'comment',
    annotationKind,
    anchorTop: viewportY,
    viewportY,
    documentOrder,
  };
}

// An isolated tick, plus two annotations sharing one anchor so they cluster.
const ticks = [
  tick('single', 'note', 100, 0),
  tick('c1', 'note', 300, 1),
  tick('c2', 'claude', 300, 2),
];

function gutter(activeCardId: string | null) {
  return (
    <AnnotationGutter
      ticks={ticks}
      viewportHeight={600}
      activeCardId={activeCardId}
      hidden={false}
      onActivate={vi.fn()}
    />
  );
}

describe('AnnotationGutter aria-current', () => {
  it('marks the active single tick and the active cluster, and omits it when inactive', () => {
    const { rerender } = render(gutter(null));
    const single = () => screen.getByRole('button', { name: 'Show note' });
    const cluster = () =>
      screen.getByRole('button', { name: 'Show first of 2 clustered annotations' });

    // Inactive: neither the isolated tick nor the cluster carries current state.
    expect(single()).not.toHaveAttribute('aria-current');
    expect(cluster()).not.toHaveAttribute('aria-current');

    // The active isolated tick is marked; the cluster stays unmarked.
    rerender(gutter('single'));
    expect(single()).toHaveAttribute('aria-current', 'true');
    expect(cluster()).not.toHaveAttribute('aria-current');

    // An active member inside the cluster marks the cluster button (not the tick).
    rerender(gutter('c1'));
    expect(cluster()).toHaveAttribute('aria-current', 'true');
    expect(single()).not.toHaveAttribute('aria-current');
  });
});
