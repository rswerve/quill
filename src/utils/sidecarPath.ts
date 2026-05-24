export function sidecarPath(filePath: string): string {
  const base = filePath.replace(/\.md$/i, '');
  return `${base}.comments.json`;
}
