// Test-harness globals injected into the page by the in-memory Tauri mock
// (`e2e/helpers/memoryTauri.ts`) and read bare (`window.__quill*`) by specs.
// Scoped to the e2e typecheck (tsconfig.e2e.json) so those reads type-check
// without each spot re-casting. Only globals read as bare `window.*` belong
// here; ones touched only through local `as unknown as` casts don't. Shapes
// mirror the harness; always-installed ones are non-optional so bare reads
// don't trip strict-null.
export {};

declare global {
  interface Window {
    __quillFiles: Record<string, string>;
    __quillCalls: Array<{ cmd: string; args: Record<string, unknown> }>;
    __quillListeners: Array<{ event: string; callback: (payload: unknown) => void }>;
    __quillEmit: (event: string, payload?: unknown) => void;
    __TAURI_INTERNALS__: unknown;
    __quillLastSpawnArgs?: Record<string, unknown>;
    __quillPrintCalls?: number;
  }
}
