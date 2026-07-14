import { layoutGutterTicks, type GutterTickInput } from './commentPositioning';

interface AnnotationGutterProps {
  ticks: GutterTickInput[];
  viewportHeight: number;
  activeCardId: string | null;
  hidden: boolean;
  onActivate: (tick: GutterTickInput) => void;
}

function TickMark({ tick, active = false }: { tick: GutterTickInput; active?: boolean }) {
  return (
    <span
      className={`annotation-gutter-mark annotation-gutter-mark-${tick.annotationKind}${active ? ' is-active' : ''}`}
      aria-hidden
    />
  );
}

export default function AnnotationGutter({
  ticks,
  viewportHeight,
  activeCardId,
  hidden,
  onActivate,
}: AnnotationGutterProps) {
  const layout = layoutGutterTicks(ticks, viewportHeight);
  const nearestAbove = layout.above.at(-1);
  const nearestBelow = layout.below[0];

  return (
    <nav className="annotation-gutter" aria-label="Document annotations" hidden={hidden}>
      <span className="annotation-gutter-guide" aria-hidden />

      {nearestAbove && (
        <button
          type="button"
          className="annotation-gutter-count annotation-gutter-count-above"
          aria-label={`${layout.above.length} annotations above the viewport`}
          onClick={() => onActivate(nearestAbove)}
        >
          <span aria-hidden>▲</span>
          <span>{layout.above.length}</span>
        </button>
      )}

      {layout.visible.map((cluster) => {
        const only = cluster.members.length === 1 ? cluster.members[0] : null;
        if (only) {
          return (
            <button
              key={cluster.clusterId}
              type="button"
              className="annotation-gutter-tick"
              style={{ top: cluster.viewportY }}
              aria-label={`Show ${only.annotationKind === 'note' ? 'note' : 'Claude thread'}`}
              onClick={() => onActivate(only)}
            >
              <TickMark tick={only} active={only.cardId === activeCardId} />
            </button>
          );
        }

        const first = cluster.members[0];
        const activeMember = cluster.members.find((member) => member.cardId === activeCardId);
        return (
          <button
            key={cluster.clusterId}
            type="button"
            className={`annotation-gutter-cluster${activeMember ? ' is-active' : ''}`}
            style={{ top: cluster.viewportY }}
            aria-label={`Show first of ${cluster.members.length} clustered annotations`}
            onClick={() => onActivate(first)}
          >
            <span className="annotation-gutter-cluster-count">{cluster.members.length}</span>
            <span className="annotation-gutter-cluster-fan" aria-hidden>
              {cluster.members.map((member, index) => {
                const offset = (index - (cluster.members.length - 1) / 2) * 10;
                return (
                  <span
                    key={member.cardId}
                    className="annotation-gutter-cluster-member"
                    style={{ '--annotation-fan-offset': `${offset}px` } as React.CSSProperties}
                  >
                    <span className="annotation-gutter-cluster-connector" />
                    <TickMark tick={member} active={member.cardId === activeCardId} />
                  </span>
                );
              })}
            </span>
          </button>
        );
      })}

      {nearestBelow && (
        <button
          type="button"
          className="annotation-gutter-count annotation-gutter-count-below"
          aria-label={`${layout.below.length} annotations below the viewport`}
          onClick={() => onActivate(nearestBelow)}
        >
          <span>{layout.below.length}</span>
          <span aria-hidden>▼</span>
        </button>
      )}
    </nav>
  );
}
