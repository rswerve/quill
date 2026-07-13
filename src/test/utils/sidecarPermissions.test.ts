import { beforeEach, describe, expect, it } from 'vitest';
import type { AISessionBinding, SidecarFile } from '../../types';
import {
  authorizeSidecarAccess,
  constrainSessionBinding,
  rememberContextFolderPermission,
  rememberSessionPermission,
} from '../../utils/sidecarPermissions';

const path = '/Users/Maz/Documents/draft.md';
const binding: AISessionBinding = {
  provider: 'claude-code',
  sessionId: 'session-1',
  cwd: '/Users/Maz/Documents',
  linkedAt: 'now',
};

function sidecar(overrides: Partial<SidecarFile> = {}): SidecarFile {
  return {
    version: 2,
    comments: [],
    suggestions: [],
    aiSession: binding,
    contextFolder: '/Users/Maz/References',
    ...overrides,
  };
}

describe('local sidecar permissions', () => {
  beforeEach(() => window.localStorage.clear());

  it('auto-activates and records a Quill-created session constrained to the document folder', () => {
    const access = authorizeSidecarAccess(
      localStorage,
      path,
      sidecar({
        aiSession: { ...binding, cwd: '/private/attacker', createdByQuill: true },
        contextFolder: undefined,
      }),
      false,
    );

    expect(access).toMatchObject({
      aiSession: {
        sessionId: 'session-1',
        cwd: '/Users/Maz/Documents',
        createdByQuill: true,
      },
      blockedSession: false,
      blockedContextFolder: false,
    });
    expect(localStorage.getItem('quill-sidecar-permissions-v1')).toContain('session-1');
  });

  it('blocks portable session and folder metadata until this path grants them locally', () => {
    expect(authorizeSidecarAccess(localStorage, path, sidecar(), false)).toMatchObject({
      aiSession: null,
      contextFolder: null,
      blockedSession: true,
      blockedContextFolder: true,
    });

    rememberSessionPermission(localStorage, path, binding);
    rememberContextFolderPermission(localStorage, path, '/Users/Maz/References');
    expect(authorizeSidecarAccess(localStorage, path, sidecar(), false)).toMatchObject({
      aiSession: binding,
      contextFolder: '/Users/Maz/References',
      blockedSession: false,
      blockedContextFolder: false,
    });
  });

  it('still blocks a foreign session without a matching local grant', () => {
    expect(
      authorizeSidecarAccess(
        localStorage,
        path,
        sidecar({ contextFolder: undefined, aiSession: { ...binding, cwd: '/private/foreign' } }),
        false,
      ),
    ).toMatchObject({
      aiSession: null,
      blockedSession: true,
      blockedContextFolder: false,
    });
  });

  it('does not transfer a grant to another document path', () => {
    rememberSessionPermission(localStorage, path, binding);
    expect(
      authorizeSidecarAccess(localStorage, '/Users/Maz/Documents/copy.md', sidecar(), false)
        .aiSession,
    ).toBeNull();
  });

  it('still blocks an imported context folder without a matching local grant', () => {
    const access = authorizeSidecarAccess(
      localStorage,
      path,
      sidecar({ aiSession: undefined, contextFolder: '/private/imported-secret' }),
      false,
    );

    expect(access).toMatchObject({
      aiSession: null,
      contextFolder: null,
      blockedSession: false,
      blockedContextFolder: true,
    });
  });

  it('constrains a Quill-created session to the document directory', () => {
    expect(
      constrainSessionBinding({ ...binding, cwd: '/private/attacker', createdByQuill: true }, path),
    ).toMatchObject({ cwd: '/Users/Maz/Documents', createdByQuill: true });
    expect(constrainSessionBinding({ ...binding, createdByQuill: true }, null)).toBeNull();
  });
});
