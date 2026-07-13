import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDocumentAIGate } from '../../hooks/useDocumentAIGate';

describe('useDocumentAIGate', () => {
  it('allows one request until its exact owner releases the document lane', () => {
    const { result } = renderHook(useDocumentAIGate);

    let acquired = false;
    act(() => {
      acquired = result.current.acquire('chat:one');
    });
    expect(acquired).toBe(true);
    act(() => {
      acquired = result.current.acquire('comment:two');
    });
    expect(acquired).toBe(false);
    expect(result.current.owns('chat:one')).toBe(true);
    expect(result.current.owns('comment:two')).toBe(false);

    act(() => result.current.release('comment:two'));
    expect(result.current.busy).toBe(true);
    act(() => result.current.release('chat:one'));
    expect(result.current.busy).toBe(false);
    act(() => {
      acquired = result.current.acquire('comment:two');
    });
    expect(acquired).toBe(true);
  });
});
