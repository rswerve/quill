import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Footer from '../../components/Footer';
import type { ClaudeModelAlias } from '../../types';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function renderFooterWithModel(opts: {
  lastKnownModel: string | null;
  claudeModel?: ClaudeModelAlias | null;
}) {
  editor = new Editor({ extensions: [StarterKit], content: '<p>draft</p>' });
  render(
    <Footer
      editor={editor}
      zoom={1}
      onZoomChange={vi.fn()}
      aiSession={null}
      lastKnownModel={opts.lastKnownModel}
      claudeModel={opts.claudeModel ?? null}
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

describe('Footer Claude model/effort display', () => {
  it('shows AUTO, never DEFAULT, for the inherit options before anything is observed', () => {
    renderFooterWithModel({ lastKnownModel: null });
    // The inherit option no longer misleads with "DEFAULT" — it reads "AUTO"
    // (Claude decides) until a real value has been observed.
    expect(screen.getByRole('combobox', { name: 'Claude model' })).toHaveDisplayValue('AUTO');
    expect(screen.getByRole('combobox', { name: 'Claude effort' })).toHaveDisplayValue('AUTO');
    expect(screen.queryByText('DEFAULT')).toBeNull();
  });

  it('surfaces the last observed model (prefix stripped) on the inherit option', () => {
    renderFooterWithModel({ lastKnownModel: 'claude-opus-4-8' });
    // Inherited-but-observed: the resolved id with the vendor prefix stripped,
    // marked "· AUTO" so it's clearly what Claude chose, not an explicit pick.
    expect(screen.getByRole('combobox', { name: 'Claude model' })).toHaveDisplayValue(
      'OPUS-4-8 · AUTO',
    );
  });

  it('an explicit selection wins and the tooltip never calls it Auto', () => {
    renderFooterWithModel({ lastKnownModel: 'claude-opus-4-8', claudeModel: 'sonnet' });
    // The explicit pick is shown, not the observed model or AUTO...
    expect(screen.getByRole('combobox', { name: 'Claude model' })).toHaveDisplayValue('SONNET');
    // ...and the tooltip describes the model line as chosen, not Auto.
    const title =
      screen.getByRole('group', { name: 'Claude settings' }).getAttribute('title') ?? '';
    expect(title).toContain('SONNET (chosen');
    expect(title).not.toMatch(/Model:[^\n]*Auto/);
  });
});
