import autoBindSession from '../../test/fixtures/ipc/auto-bind-session.json' with { type: 'json' };

/**
 * Canonical IPC payloads shared with Rust serialization tests and frontend
 * validator tests. E2E mocks must consume these objects instead of inventing
 * command-result shapes independently.
 */
export const ipcFixtures = {
  autoBindSession,
};
