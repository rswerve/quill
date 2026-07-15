import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolbarButton } from '../../components/Toolbar';

// Contract for the shared button helper's stateClasses seam (added so Rail can
// module-scope `.btn.active`/`.mixed`/`.disabled`). The safety net that matters
// when touching shared infra: prove the legacy literal STATE classes still apply
// when no map is supplied (Toolbar's fallback), and that a supplied map fully
// replaces them. baseClassName is required, so each render names an explicit base.
describe('ToolbarButton stateClasses contract', () => {
  it('emits the legacy literal state classes when no map is supplied', () => {
    render(
      <ToolbarButton
        onClick={vi.fn()}
        active
        mixed
        disabled
        title="X"
        baseClassName="test-toolbar-button"
      >
        X
      </ToolbarButton>,
    );
    const button = screen.getByRole('button', { name: 'X' });
    expect(button).toHaveClass('test-toolbar-button', 'active', 'mixed', 'disabled');
  });

  it('applies only the state classes whose flag is set', () => {
    render(
      <ToolbarButton
        onClick={vi.fn()}
        active
        title="Only active"
        baseClassName="test-toolbar-button"
      >
        A
      </ToolbarButton>,
    );
    const button = screen.getByRole('button', { name: 'Only active' });
    expect(button).toHaveClass('active');
    expect(button).not.toHaveClass('mixed');
    expect(button).not.toHaveClass('disabled');
  });

  it('a supplied map replaces the literals — mapped classes in, literals out', () => {
    render(
      <ToolbarButton
        onClick={vi.fn()}
        active
        mixed
        disabled
        title="Mapped"
        baseClassName="rail_btn_hash"
        stateClasses={{ active: 'a_hash', mixed: 'm_hash', disabled: 'd_hash' }}
      >
        M
      </ToolbarButton>,
    );
    const button = screen.getByRole('button', { name: 'Mapped' });
    expect(button).toHaveClass('rail_btn_hash', 'a_hash', 'm_hash', 'd_hash');
    expect(button).not.toHaveClass('active');
    expect(button).not.toHaveClass('mixed');
    expect(button).not.toHaveClass('disabled');
  });

  it('leaves the aria-pressed semantics unchanged regardless of the map', () => {
    const { rerender } = render(
      <ToolbarButton
        onClick={vi.fn()}
        mixed
        title="P"
        baseClassName="test-toolbar-button"
        stateClasses={{ active: 'a', mixed: 'm', disabled: 'd' }}
      >
        P
      </ToolbarButton>,
    );
    // mixed → "mixed"; the state class is remapped but the ARIA contract isn't.
    expect(screen.getByRole('button', { name: 'P' })).toHaveAttribute('aria-pressed', 'mixed');

    rerender(
      <ToolbarButton
        onClick={vi.fn()}
        active
        title="P"
        baseClassName="test-toolbar-button"
        stateClasses={{ active: 'a', mixed: 'm', disabled: 'd' }}
      >
        P
      </ToolbarButton>,
    );
    expect(screen.getByRole('button', { name: 'P' })).toHaveAttribute('aria-pressed', 'true');
  });
});
