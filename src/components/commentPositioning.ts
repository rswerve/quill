export interface AnchoredCardInput {
  cardId: string;
  anchorTop: number;
  height: number;
  documentOrder: number;
}

export interface PositionedCard extends AnchoredCardInput {
  top: number;
}

export interface AnchoredPanelLayout {
  positions: PositionedCard[];
  above: string[];
  below: string[];
}

interface LayoutOptions {
  viewportTop: number;
  viewportBottom: number;
  cardViewportTop?: number;
  cardViewportBottom?: number;
  activeCardId: string | null;
  gap: number;
}

/**
 * Positions anchored cards without changing document order.
 *
 * At rest collisions cascade downward. When one card is active, it keeps its
 * exact anchor top; earlier neighbors reflow upward and later neighbors reflow
 * downward around it. Cards whose anchors are outside the panel viewport are
 * represented by the `above` / `below` lists instead of card positions.
 */
export function layoutAnchoredCards(
  cards: AnchoredCardInput[],
  {
    viewportTop,
    viewportBottom,
    cardViewportTop = viewportTop,
    cardViewportBottom = viewportBottom,
    activeCardId,
    gap,
  }: LayoutOptions,
): AnchoredPanelLayout {
  const ordered = [...cards].sort(
    (a, b) => a.anchorTop - b.anchorTop || a.documentOrder - b.documentOrder,
  );
  const above = ordered.filter((card) => card.anchorTop < viewportTop).map((card) => card.cardId);
  const below = ordered
    .filter((card) => card.anchorTop >= viewportBottom)
    .map((card) => card.cardId);
  const visible = ordered.filter(
    (card) => card.anchorTop >= viewportTop && card.anchorTop < viewportBottom,
  );

  if (visible.length === 0) return { positions: [], above, below };

  const positions: PositionedCard[] = visible.map((card) => ({
    ...card,
    top: Math.min(
      Math.max(card.anchorTop, cardViewportTop),
      Math.max(cardViewportTop, cardViewportBottom - card.height),
    ),
  }));
  const activeIndex = activeCardId
    ? positions.findIndex((card) => card.cardId === activeCardId)
    : -1;

  if (activeIndex < 0) {
    let cursor = positions[0].top;
    for (const card of positions) {
      card.top = Math.max(card.top, cursor);
      cursor = card.top + card.height + gap;
    }
    return { positions, above, below };
  }

  const activeTop = positions[activeIndex].top;
  positions[activeIndex].top = activeTop;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const card = positions[index];
    const next = positions[index + 1];
    card.top = Math.min(card.top, next.top - gap - card.height);
  }
  let cursor = positions[activeIndex].top + positions[activeIndex].height + gap;
  for (let index = activeIndex + 1; index < positions.length; index += 1) {
    const card = positions[index];
    card.top = Math.max(card.top, cursor);
    cursor = card.top + card.height + gap;
  }

  return { positions, above, below };
}
