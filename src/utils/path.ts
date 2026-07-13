/**
 * Final segment of a file path, handling both POSIX (`/`) and Windows (`\`)
 * separators — splitting on `/` alone shows the full path as the filename on
 * Windows.
 */
export function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}

/**
 * Containing directory of a file path, handling both separators. Returns null
 * when the path has no directory component.
 */
export function dirname(path: string): string | null {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i < 0) return null;
  if (i === 0) return path[0];
  return path.slice(0, i);
}

/**
 * Stable identity for a document path owned by an open tab. File dialogs and
 * deep links can spell the same macOS path with different separators, case, or
 * `.` / `..` segments; those aliases must not create two writable owners.
 *
 * This is intentionally lexical rather than filesystem-backed. Tauri's file
 * picker supplies absolute paths, and resolving symlinks here would add an
 * asynchronous filesystem permission check to every open/save operation.
 */
export function canonicalDocumentPath(path: string): string {
  const slashPath = path.replace(/\\/g, '/');
  const driveMatch = /^([a-zA-Z]:)(?:\/|$)/.exec(slashPath);
  const drive = driveMatch?.[1] ?? '';
  const rest = driveMatch ? slashPath.slice(driveMatch[0].length) : slashPath;
  const absolute = drive.length > 0 || rest.startsWith('/');
  const segments: string[] = [];

  for (const segment of rest.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  let prefix = '';
  if (drive) prefix = `${drive}/`;
  else if (absolute) prefix = '/';
  return `${prefix}${segments.join('/')}`.normalize('NFC').toLocaleLowerCase('en-US');
}
