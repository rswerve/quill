import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export type EditProjectionSource = 'text' | 'hardBreak' | 'blockBoundary' | 'otherLeaf';

export interface EditTextProjection {
  /** Edit-only plaintext. This must never replace the anchor-facing rangeText projection. */
  text: string;
  /** Absolute ProseMirror position at every projected character boundary. */
  positions: number[];
  /** Provenance for each projected character. */
  sources: EditProjectionSource[];
}

export interface EditTextMatch {
  from: number;
  to: number;
}

/**
 * Build a mapped plaintext view for quote-based edit matching.
 *
 * Canonical mode gives an existing Shift+Enter hard break the explicit `\n`
 * spelling used by the edit protocol. Legacy mode retains the historical leaf
 * space so old model quotes keep matching. Block boundaries remain `\n` in
 * both modes, with their provenance kept separately from hard breaks.
 */
export function buildEditTextProjection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  mode: 'canonical' | 'legacy',
): EditTextProjection {
  const characters: string[] = [];
  const positions: number[] = [];
  const sources: EditProjectionSource[] = [];
  let firstBlock = true;
  let lastEnd = from;

  const emit = (character: string, position: number, source: EditProjectionSource) => {
    characters.push(character);
    positions.push(position);
    sources.push(source);
  };

  doc.nodesBetween(from, to, (node, pos) => {
    const isLeaf = !node.isText && node.isLeaf;
    const leafCharacter =
      isLeaf && node.type.name === 'hardBreak' && mode === 'canonical' ? '\n' : ' ';

    // Mirror Fragment.textBetween: every textblock after the first contributes
    // one block separator, including an empty textblock. Block leaves that
    // render leaf text do the same.
    if (node.isBlock && ((node.isLeaf && leafCharacter) || node.isTextblock)) {
      if (firstBlock) firstBlock = false;
      else emit('\n', lastEnd, 'blockBoundary');
    }

    if (node.isText) {
      const start = Math.max(pos, from);
      const end = Math.min(pos + node.nodeSize, to);
      const value = node.text ?? '';
      for (let position = start; position < end; position += 1) {
        emit(value[position - pos], position, 'text');
      }
      if (end > start) lastEnd = end;
    } else if (isLeaf) {
      const start = Math.max(pos, from);
      emit(leafCharacter, start, node.type.name === 'hardBreak' ? 'hardBreak' : 'otherLeaf');
      lastEnd = Math.min(pos + node.nodeSize, to);
    }
  });

  positions.push(lastEnd);
  return { text: characters.join(''), positions, sources };
}

function allIndexesOf(text: string, candidate: string): number[] {
  if (candidate.length === 0) return [0];
  const indexes: number[] = [];
  let index = text.indexOf(candidate);
  while (index !== -1) {
    indexes.push(index);
    index = text.indexOf(candidate, index + 1);
  }
  return indexes;
}

interface CollapsedFind {
  text: string;
  /** Output offsets whose newline represents a collapsed Markdown blank line. */
  requiredBlockOffsets: number[];
}

/** Collapse Markdown blank-line runs while remembering exactly which LFs changed meaning. */
function collapseMarkdownBlankLines(value: string): CollapsedFind | null {
  let output = '';
  const requiredBlockOffsets: number[] = [];
  let changed = false;

  for (let index = 0; index < value.length; ) {
    if (value[index] !== '\n') {
      output += value[index];
      index += 1;
      continue;
    }

    let cursor = index + 1;
    while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
    let newlineCount = 1;
    while (value[cursor] === '\n') {
      newlineCount += 1;
      cursor += 1;
      while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
    }
    if (newlineCount < 2) {
      output += '\n';
      index += 1;
      continue;
    }

    requiredBlockOffsets.push(output.length);
    output += '\n';
    index = cursor;
    changed = true;
  }

  return changed ? { text: output, requiredBlockOffsets } : null;
}

function projectionMatches(
  projection: EditTextProjection,
  candidate: string,
  requiredBlockOffsets: readonly number[] = [],
): EditTextMatch[] {
  return allIndexesOf(projection.text, candidate).flatMap((index) => {
    const valid = requiredBlockOffsets.every(
      (offset) => projection.sources[index + offset] === 'blockBoundary',
    );
    if (!valid) return [];
    const from = projection.positions[index];
    const to = projection.positions[index + candidate.length];
    return from === undefined || to === undefined ? [] : [{ from, to }];
  });
}

/**
 * Locate every occurrence under the edit protocol's compatibility rules.
 *
 * A find containing `\n` opts into the canonical projection. Its verbatim
 * matches always win. Only when none exist may a Markdown blank-line run
 * collapse, and each collapsed LF must land on a real block boundary rather
 * than a hard break. A find without `\n` retains the legacy leaf-space view so
 * existing payloads preserve their first-match behavior.
 */
export function locateEditTextMatches(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  find: string,
): EditTextMatch[] {
  const mode = find.includes('\n') ? 'canonical' : 'legacy';
  const projection = buildEditTextProjection(doc, from, to, mode);
  const verbatim = projectionMatches(projection, find);
  if (verbatim.length > 0 || mode === 'legacy') return verbatim;

  const collapsed = collapseMarkdownBlankLines(find);
  if (!collapsed) return [];
  return projectionMatches(projection, collapsed.text, collapsed.requiredBlockOffsets);
}
