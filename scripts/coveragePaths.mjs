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
