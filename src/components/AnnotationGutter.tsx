import { layoutGutterTicks, type GutterTickInput } from './commentPositioning';
import { cx } from '../utils/cx';
import styles from './AnnotationGutter.module.css';

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
      className={cx(
        styles.mark,
        tick.annotationKind === 'note' ? styles.markNote : styles.markClaude,
        active && styles.active,
      )}
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
    <nav className={styles.gutter} aria-label="Document annotations" hidden={hidden}>
      <span className={styles.guide} aria-hidden />

      {nearestAbove && (
        <button
          type="button"
          className={cx(styles.count, styles.countAbove)}
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
              className={styles.tick}
              style={{ top: cluster.viewportY }}
              aria-label={`Show ${only.annotationKind === 'note' ? 'note' : 'Claude thread'}`}
              aria-current={only.cardId === activeCardId ? 'true' : undefined}
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
            className={cx(styles.cluster, activeMember && styles.active)}
            style={{ top: cluster.viewportY }}
            aria-label={`Show first of ${cluster.members.length} clustered annotations`}
            aria-current={activeMember ? 'true' : undefined}
            onClick={() => onActivate(first)}
          >
            <span className={styles.clusterCount}>{cluster.members.length}</span>
            <span className={styles.clusterFan} aria-hidden>
              {cluster.members.map((member, index) => {
                const offset = (index - (cluster.members.length - 1) / 2) * 10;
                return (
                  <span
                    key={member.cardId}
                    className={styles.clusterMember}
                    style={{ '--annotation-fan-offset': `${offset}px` } as React.CSSProperties}
                  >
                    <span className={styles.clusterConnector} />
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
          className={cx(styles.count, styles.countBelow)}
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
