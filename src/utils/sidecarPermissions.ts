import type { AISessionBinding, SidecarFile } from '../types';
import { canonicalDocumentPath, dirname } from './path';

const STORAGE_KEY = 'quill-sidecar-permissions-v1';

interface SessionPermission {
  sessionId: string;
  cwd: string;
  createdByQuill: boolean;
}

interface DocumentPermissions {
  session?: SessionPermission;
  contextFolder?: string;
}

type PermissionRegistry = Record<string, DocumentPermissions>;

export interface AuthorizedSidecarAccess {
  aiSession: AISessionBinding | null;
  contextFolder: string | null;
  blockedSession: boolean;
  blockedContextFolder: boolean;
}

function readRegistry(storage: Storage): PermissionRegistry {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PermissionRegistry) : {};
  } catch {
    return {};
  }
}

function writeRegistry(storage: Storage, registry: PermissionRegistry) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(registry));
  } catch (error) {
    // Fail closed: if the local grant cannot be persisted, the next reopen
    // asks again instead of trusting portable sidecar metadata.
    console.warn('Could not persist local sidecar permissions:', error);
  }
}

function updateDocumentPermission(
  storage: Storage,
  filePath: string,
  update: (current: DocumentPermissions) => DocumentPermissions,
) {
  const registry = readRegistry(storage);
  const key = canonicalDocumentPath(filePath);
  const next = update(registry[key] ?? {});
  if (!next.session && !next.contextFolder) delete registry[key];
  else registry[key] = next;
  writeRegistry(storage, registry);
}

/** Quill-created sessions always run in the current document's directory. */
export function constrainSessionBinding(
  binding: AISessionBinding | null | undefined,
  filePath: string | null,
): AISessionBinding | null {
  if (!binding) return null;
  if (binding.createdByQuill !== true) return binding;
  if (!filePath) return null;
  const documentDirectory = dirname(filePath);
  if (!documentDirectory) return null;
  return { ...binding, cwd: documentDirectory };
}

function sessionPermission(binding: AISessionBinding): SessionPermission {
  return {
    sessionId: binding.sessionId,
    cwd: canonicalDocumentPath(binding.cwd),
    createdByQuill: binding.createdByQuill === true,
  };
}

function sessionsMatch(permission: SessionPermission | undefined, binding: AISessionBinding) {
  if (!permission) return false;
  const candidate = sessionPermission(binding);
  return (
    permission.sessionId === candidate.sessionId &&
    permission.cwd === candidate.cwd &&
    permission.createdByQuill === candidate.createdByQuill
  );
}

export function rememberSessionPermission(
  storage: Storage,
  filePath: string,
  binding: AISessionBinding | null,
) {
  updateDocumentPermission(storage, filePath, (current) => ({
    ...current,
    ...(binding ? { session: sessionPermission(binding) } : { session: undefined }),
  }));
}

export function rememberContextFolderPermission(
  storage: Storage,
  filePath: string,
  folder: string | null,
) {
  updateDocumentPermission(storage, filePath, (current) => ({
    ...current,
    ...(folder ? { contextFolder: canonicalDocumentPath(folder) } : { contextFolder: undefined }),
  }));
}

/**
 * Sidecar bindings are portable metadata, not portable filesystem grants.
 * Activate only values previously approved for this exact local document path.
 * A backend auto-bind is locally discovered rather than imported and is trusted.
 */
export function authorizeSidecarAccess(
  storage: Storage,
  filePath: string,
  sidecar: SidecarFile,
  autoBound: boolean,
): AuthorizedSidecarAccess {
  const permission = readRegistry(storage)[canonicalDocumentPath(filePath)];
  const constrainedSession = constrainSessionBinding(sidecar.aiSession, filePath);
  const sessionAllowed =
    constrainedSession !== null &&
    (autoBound || sessionsMatch(permission?.session, constrainedSession));
  const contextFolder = sidecar.contextFolder ?? null;
  const contextAllowed =
    contextFolder !== null && permission?.contextFolder === canonicalDocumentPath(contextFolder);

  return {
    aiSession: sessionAllowed ? constrainedSession : null,
    contextFolder: contextAllowed ? contextFolder : null,
    blockedSession: sidecar.aiSession !== undefined && !sessionAllowed,
    blockedContextFolder: contextFolder !== null && !contextAllowed,
  };
}
