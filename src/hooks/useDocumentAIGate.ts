import { useCallback, useMemo, useRef, useState } from 'react';

export const DOCUMENT_AI_BUSY_MESSAGE =
  'Claude is already responding in this document. Wait for it to finish or stop it before starting another request.';

export interface DocumentAIRequestGate {
  busy: boolean;
  acquire: (requestId: string) => boolean;
  owns: (requestId: string) => boolean;
  release: (requestId: string) => void;
}

/**
 * One cooperative AI lane per mounted document. Chat and margin-comment
 * requests share this gate so two `--resume` children can never mutate the
 * same Claude session concurrently.
 */
export function useDocumentAIGate(): DocumentAIRequestGate {
  const ownerRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);

  const acquire = useCallback((requestId: string) => {
    if (ownerRef.current !== null) return false;
    ownerRef.current = requestId;
    setBusy(true);
    return true;
  }, []);

  const owns = useCallback((requestId: string) => ownerRef.current === requestId, []);

  const release = useCallback((requestId: string) => {
    if (ownerRef.current !== requestId) return;
    ownerRef.current = null;
    setBusy(false);
  }, []);

  return useMemo(() => ({ busy, acquire, owns, release }), [acquire, busy, owns, release]);
}
