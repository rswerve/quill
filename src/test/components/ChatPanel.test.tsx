import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ChatPanel from '../../components/ChatPanel';
import type { ChatMessage, TrackedChangeInfo } from '../../types';

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', text: 'Tighten the opening', createdAt: 'now' },
  {
    id: 'a1',
    role: 'assistant',
    text: 'I tightened it.',
    createdAt: 'later',
    model: 'claude-sonnet',
    suggestionIds: ['replacement'],
  },
];

const trackedChanges: TrackedChangeInfo[] = [
  {
    id: 'replacement',
    authorID: 'claude',
    status: 'pending',
    createdAt: 1,
    segments: [
      { kind: 'delete', from: 1, to: 4, text: 'old' },
      { kind: 'insert', from: 1, to: 4, text: 'new' },
    ],
  },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  const props: React.ComponentProps<typeof ChatPanel> = {
    hidden: false,
    messages,
    trackedChanges,
    focusRevision: 0,
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    onViewSuggestions: vi.fn(),
    busy: false,
    ...overrides,
  };
  render(<ChatPanel {...props} />);
  return props;
}

describe('ChatPanel', () => {
  it('renders the two-sided thread and jumps to linked suggestions', () => {
    const props = renderPanel();
    expect(screen.getByText('Tighten the opening')).toHaveAttribute('data-chat-role', 'user');
    expect(screen.getByText('I tightened it.')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /1 suggestion in the doc/ }));
    expect(props.onViewSuggestions).toHaveBeenCalledWith(['replacement']);
  });

  it('sends with Command-Enter and disables sending while a response streams', () => {
    const props = renderPanel({ messages: [] });
    const composer = screen.getByLabelText('Ask Claude about this document');
    fireEvent.change(composer, { target: { value: 'Explain this section' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    expect(props.onSend).toHaveBeenCalledWith('Explain this section');
    expect(composer).toHaveValue('');

    renderPanel({
      messages: [
        { id: 'u2', role: 'user', text: 'Continue', createdAt: 'now' },
        { id: 'a2', role: 'assistant', text: 'Working', createdAt: 'now', pending: true },
      ],
    });
    expect(screen.getAllByRole('button', { name: 'Send chat message' }).at(-1)).toBeDisabled();
  });

  it('shows a thinking indicator before text and a caret after streaming begins', () => {
    const { container, rerender } = render(
      <ChatPanel
        hidden={false}
        messages={[
          { id: 'a-thinking', role: 'assistant', text: '', createdAt: 'now', pending: true },
        ]}
        trackedChanges={[]}
        focusRevision={0}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        onViewSuggestions={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Claude is thinking…');
    expect(container.querySelector('[data-chat-caret]')).not.toBeInTheDocument();

    rerender(
      <ChatPanel
        hidden={false}
        messages={[
          {
            id: 'a-thinking',
            role: 'assistant',
            text: 'Streaming now',
            createdAt: 'now',
            pending: true,
          },
        ]}
        trackedChanges={[]}
        focusRevision={0}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        onViewSuggestions={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.queryByText('Claude is thinking…')).not.toBeInTheDocument();
    expect(container.querySelector('[data-chat-caret]')).toBeInTheDocument();
  });

  it('exposes Stop and Retry/Dismiss terminal actions', () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    renderPanel({
      messages: [
        { id: 'a-stream', role: 'assistant', text: 'Working', createdAt: 'now', pending: true },
        {
          id: 'a-error',
          role: 'assistant',
          text: '',
          createdAt: 'now',
          error: 'Session no longer available',
        },
      ],
      onCancel,
      onRetry,
      onDismiss,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onCancel).toHaveBeenCalledWith('a-stream');
    expect(onRetry).toHaveBeenCalledWith('a-error');
    expect(onDismiss).toHaveBeenCalledWith('a-error');
    // The terminal actions are identified by their accessible names and behavior
    // above; each carries its own SVG glyph.
    expect(screen.getByRole('button', { name: 'Stop' }).querySelector('svg')).toBeInTheDocument();
  });
});
