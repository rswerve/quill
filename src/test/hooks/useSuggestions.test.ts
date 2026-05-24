import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSuggestions } from '../../hooks/useSuggestions';
import type { Suggestion } from '../../types';

function makeSuggestion(id: string, status: Suggestion['status'] = 'pending'): Suggestion {
  return {
    id,
    type: 'insertion',
    from: 0,
    to: 5,
    originalText: '',
    suggestedText: 'hello',
    author: 'Alice',
    createdAt: new Date().toISOString(),
    status,
  };
}

describe('useSuggestions', () => {
  describe('acceptSuggestion', () => {
    it('sets the target suggestion status to accepted', () => {
      const { result } = renderHook(() => useSuggestions());
      act(() => {
        result.current.setSuggestions([makeSuggestion('s1'), makeSuggestion('s2')]);
      });
      act(() => {
        result.current.acceptSuggestion('s1');
      });
      expect(result.current.suggestions.find((s) => s.id === 's1')?.status).toBe('accepted');
      expect(result.current.suggestions.find((s) => s.id === 's2')?.status).toBe('pending');
    });

    it('is a no-op when the id does not exist', () => {
      const { result } = renderHook(() => useSuggestions());
      act(() => {
        result.current.setSuggestions([makeSuggestion('s1')]);
      });
      act(() => {
        result.current.acceptSuggestion('nonexistent');
      });
      expect(result.current.suggestions[0].status).toBe('pending');
    });
  });

  describe('rejectSuggestion', () => {
    it('sets the target suggestion status to rejected', () => {
      const { result } = renderHook(() => useSuggestions());
      act(() => {
        result.current.setSuggestions([makeSuggestion('s1')]);
      });
      act(() => {
        result.current.rejectSuggestion('s1');
      });
      expect(result.current.suggestions[0].status).toBe('rejected');
    });
  });

  describe('acceptAllSuggestions', () => {
    it('sets all pending suggestions to accepted', () => {
      const { result } = renderHook(() => useSuggestions());
      act(() => {
        result.current.setSuggestions([
          makeSuggestion('s1', 'pending'),
          makeSuggestion('s2', 'pending'),
          makeSuggestion('s3', 'rejected'),
        ]);
      });
      act(() => {
        result.current.acceptAllSuggestions();
      });
      expect(result.current.suggestions.find((s) => s.id === 's1')?.status).toBe('accepted');
      expect(result.current.suggestions.find((s) => s.id === 's2')?.status).toBe('accepted');
      expect(result.current.suggestions.find((s) => s.id === 's3')?.status).toBe('rejected');
    });

    it('does not change already-accepted suggestions', () => {
      const { result } = renderHook(() => useSuggestions());
      act(() => {
        result.current.setSuggestions([makeSuggestion('s1', 'accepted')]);
      });
      act(() => {
        result.current.acceptAllSuggestions();
      });
      expect(result.current.suggestions[0].status).toBe('accepted');
    });

    it('is a no-op on an empty list', () => {
      const { result } = renderHook(() => useSuggestions());
      act(() => {
        result.current.acceptAllSuggestions();
      });
      expect(result.current.suggestions).toHaveLength(0);
    });
  });

  describe('rejectAllSuggestions', () => {
    it('sets all pending suggestions to rejected', () => {
      const { result } = renderHook(() => useSuggestions());
      act(() => {
        result.current.setSuggestions([
          makeSuggestion('s1', 'pending'),
          makeSuggestion('s2', 'accepted'),
        ]);
      });
      act(() => {
        result.current.rejectAllSuggestions();
      });
      expect(result.current.suggestions.find((s) => s.id === 's1')?.status).toBe('rejected');
      expect(result.current.suggestions.find((s) => s.id === 's2')?.status).toBe('accepted');
    });
  });
});
