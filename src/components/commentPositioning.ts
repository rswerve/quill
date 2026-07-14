export type GutterAnnotationKind = 'note' | 'claude';
export type GutterTargetKind = 'comment' | 'suggestion';

export interface GutterTickInput {
  cardId: string;
  targetKind: GutterTargetKind;
  annotationKind: GutterAnnotationKind;
  anchorTop: number;
  viewportY: number;
  documentOrder: number;
}

export interface GutterTickCluster {
  clusterId: string;
  viewportY: number;
  members: GutterTickInput[];
}

export interface GutterLayout {
  above: GutterTickInput[];
  below: GutterTickInput[];
  visible: GutterTickCluster[];
}

/**
 * Splits line-aligned gutter ticks by viewport and collapses ticks closer than
 * `clusterDistance` into one stable, document-ordered cluster. This is purely
 * visual grouping; each member keeps its own navigation target.
 */
export function layoutGutterTicks(
  ticks: GutterTickInput[],
  viewportHeight: number,
  clusterDistance = 14,
): GutterLayout {
  const ordered = [...ticks].sort(
    (a, b) => a.viewportY - b.viewportY || a.documentOrder - b.documentOrder,
  );
  const above = ordered.filter((tick) => tick.viewportY < 0);
  const below = ordered.filter((tick) => tick.viewportY >= viewportHeight);
  const inView = ordered.filter((tick) => tick.viewportY >= 0 && tick.viewportY < viewportHeight);
  const groups: GutterTickInput[][] = [];
  for (const tick of inView) {
    const current = groups.at(-1);
    if (!current || tick.viewportY - current.at(-1)!.viewportY >= clusterDistance) {
      groups.push([tick]);
    } else {
      current.push(tick);
    }
  }

  return {
    above,
    below,
    visible: groups.map((members) => ({
      clusterId: members.map((member) => member.cardId).join(':'),
      viewportY: members.reduce((total, member) => total + member.viewportY, 0) / members.length,
      members,
    })),
  };
}

/** The annotation whose document-space anchor is nearest the viewport center. */
export function nearestGutterTick(
  ticks: GutterTickInput[],
  viewportCenter: number,
): GutterTickInput | null {
  let nearest: GutterTickInput | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const tick of ticks) {
    const nextDistance = Math.abs(tick.anchorTop - viewportCenter);
    if (
      nextDistance < distance ||
      (nextDistance === distance && nearest !== null && tick.documentOrder < nearest.documentOrder)
    ) {
      nearest = tick;
      distance = nextDistance;
    }
  }
  return nearest;
}

/**
 * Returns a centered scroll target only when the card has left the middle 60%
 * comfort band. `null` means the panel should stay still.
 */
export function panelNudgeTarget(
  panelScrollTop: number,
  panelHeight: number,
  cardTop: number,
  cardHeight: number,
): number | null {
  const bandTop = panelScrollTop + panelHeight * 0.2;
  const bandBottom = panelScrollTop + panelHeight * 0.8;
  const cardBottom = cardTop + cardHeight;
  if (cardTop >= bandTop && cardBottom <= bandBottom) return null;
  return Math.max(0, cardTop + cardHeight / 2 - panelHeight / 2);
}
