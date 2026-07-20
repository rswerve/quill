import type { Node as PMNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import type { StructuralReviewEnvelope } from '../types';
import type { MarkdownSerialize } from './structuralFingerprint';
import { reconstructBlockUnions, type ReconstructionResult } from './structuralReconstruction';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStructuralEnvelopeShape(raw: unknown): raw is StructuralReviewEnvelope {
  return (
    isPlainObject(raw) &&
    raw.version === 1 &&
    typeof raw.sourceDocumentHash === 'string' &&
    raw.sourceDocumentHash.length > 0 &&
    Array.isArray(raw.records)
  );
}

/**
 * Validate the persisted structural envelope's shape; null if malformed. Records
 * are NOT deeply validated here — reconstruction is the per-record trust boundary.
 */
export function parseStructuralEnvelope(raw: unknown): StructuralReviewEnvelope | null {
  return isStructuralEnvelopeShape(raw) ? raw : null;
}

/**
 * Reconstruct the review document from a persisted structural envelope, gated on
 * the whole-document source hash (the SHA-256 the atomic file layer returns for
 * the `.md`). A hash mismatch means the file changed outside Quill, so EVERY
 * record is quarantined and nothing is inserted — the block cannot be misbound
 * onto a shifted or duplicated occurrence (the F5 alias defense). On a match, the
 * per-record boundary in `reconstructBlockUnions` applies.
 */
export function reconstructFromEnvelope(
  sourceDoc: PMNode,
  currentSourceHash: string,
  envelope: StructuralReviewEnvelope,
  serialize: MarkdownSerialize,
): ReconstructionResult {
  if (envelope.sourceDocumentHash !== currentSourceHash) {
    return {
      doc: sourceDoc,
      mapping: new Transform(sourceDoc).mapping,
      restored: [],
      quarantined: [...envelope.records],
    };
  }
  return reconstructBlockUnions(sourceDoc, envelope.records, serialize);
}
