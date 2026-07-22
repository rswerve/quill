import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function isApplicationSource(sourcePath) {
  const normalized = decodeURIComponent(sourcePath).replaceAll('\\', '/');
  return (
    /\.tsx?$/.test(normalized) &&
    !/(^|\/)node_modules\//.test(normalized) &&
    !/(^|\/)main\.tsx$/.test(normalized) &&
    !/(^|\/)vite-env\.d\.ts$/.test(normalized) &&
    !/(^|\/)test\//.test(normalized) &&
    !/(^|\/)types\//.test(normalized)
  );
}

export function applicationSourcePath(sourcePath, info = {}, root = projectRoot) {
  const normalized = decodeURIComponent(sourcePath).replaceAll('\\', '/');
  const distFile = `${info.distFile ?? ''}`.replaceAll('\\', '/');
  for (const candidate of [distFile, normalized]) {
    const absoluteSrcIndex = candidate.lastIndexOf('/src/');
    if (absoluteSrcIndex >= 0) {
      return path.join(root, candidate.slice(absoluteSrcIndex + 1));
    }
    const relativeSrcIndex = candidate.indexOf('src/');
    if (relativeSrcIndex >= 0) {
      return path.join(root, candidate.slice(relativeSrcIndex));
    }
  }
  return normalized;
}

/**
 * Whether a V8 coverage entry URL is worth collecting.
 *
 * Shared by the Playwright fixture, which decides what to hand the reporter,
 * and by the reporter's own entryFilter. Those used to hold separate copies of
 * this rule, and a production experiment showed why that is dangerous:
 * widening one of them did nothing at all, because the other had already
 * discarded the entries, and the run recorded zero coverage while appearing to
 * succeed.
 *
 * Only dev-server module URLs qualify. Coverage is deliberately NOT collected
 * from a built bundle: bundling coarsens the sourcemap, so V8 byte ranges land
 * on over-broad source ranges and lines get credited that never ran - measured
 * at 61 to 198 phantom covered lines depending on minification, including the
 * bodies of components no test renders. Accepting `/assets/*.js` is what a
 * bundled-coverage lane would need; it is left out on purpose rather than kept
 * dormant, so nobody mistakes it for a working path.
 */
export function isCollectableCoverageUrl(pathname) {
  return pathname.startsWith('/src/') && isApplicationSource(pathname);
}
