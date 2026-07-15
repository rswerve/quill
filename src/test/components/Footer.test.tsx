import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Footer from '../../components/Footer';
import { MAX_ZOOM, MIN_ZOOM } from '../../utils/zoomPreference';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function renderFooter(zoom: number) {
  editor = new Editor({ extensions: [StarterKit], content: '<p>draft</p>' });
  const onZoomChange = vi.fn();
  render(
    <Footer
      editor={editor}
      zoom={zoom}
      onZoomChange={onZoomChange}
      aiSession={null}
      lastKnownModel={null}
      claudeModel={null}
      claudeEffort={null}
      onClaudeModelChange={vi.fn()}
      onClaudeEffortChange={vi.fn()}
      onOpenSessionPicker={vi.fn()}
      onUnlinkSession={vi.fn()}
      contextFolder={null}
      onLinkContextFolder={vi.fn()}
      onUnlinkContextFolder={vi.fn()}
    />,
  );
  return onZoomChange;
}

describe('Footer zoom controls', () => {
  it('steps zoom in and out by the keyboard-shortcut increment', () => {
    const onZoomChange = renderFooter(1);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onZoomChange).toHaveBeenLastCalledWith(1.12);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(onZoomChange).toHaveBeenLastCalledWith(0.88);
  });

  it('renders the zoom readout as a quiet output, not a live region', () => {
    renderFooter(1);
    // An <output> (implicit role="status") so it is a labelled readout, but
    // aria-live="off" so dragging the slider does not announce every percent.
    const readout = screen.getByRole('status', { name: 'Zoom level' });
    expect(readout.tagName).toBe('OUTPUT');
    expect(readout).toHaveAttribute('aria-live', 'off');
    expect(readout).toHaveTextContent('100%');
  });

  it('disables the outward control at each zoom bound', () => {
    const { unmount } = renderWithZoom(MIN_ZOOM);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();

    unmount();
    renderWithZoom(MAX_ZOOM);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
  });
});

function renderWithZoom(zoom: number) {
  editor?.destroy();
  editor = new Editor({ extensions: [StarterKit], content: '<p>draft</p>' });
  return render(
    <Footer
      editor={editor}
      zoom={zoom}
      onZoomChange={vi.fn()}
      aiSession={null}
      lastKnownModel={null}
      claudeModel={null}
      claudeEffort={null}
      onClaudeModelChange={vi.fn()}
      onClaudeEffortChange={vi.fn()}
      onOpenSessionPicker={vi.fn()}
      onUnlinkSession={vi.fn()}
      contextFolder={null}
      onLinkContextFolder={vi.fn()}
      onUnlinkContextFolder={vi.fn()}
    />,
  );
}
