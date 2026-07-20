import type {
  HeadingLevel,
  StructuralListType,
  StructuralOp,
  StructuralSuggestionRecord,
} from '../types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHeadingLevel(value: unknown): value is HeadingLevel {
  return isFiniteInt(value) && value >= 1 && value <= 6;
}

function isStructuralListType(value: unknown): value is StructuralListType {
  return value === 'bulletList' || value === 'orderedList' || value === 'taskList';
}

/** Exhaustive runtime validation of a persisted typed structural operation. */
export function isStructuralOp(value: unknown): value is StructuralOp {
  if (!isPlainObject(value)) return false;
  switch (value.kind) {
    case 'headingToParagraph':
    case 'paragraphToHeading':
      return isHeadingLevel(value.level);
    case 'listToParagraph':
    case 'paragraphToList':
      return isStructuralListType(value.listType);
    case 'splitParagraph':
    case 'mergeParagraphs':
      // No op-level fields; the block counts are validated from the record's
      // anchor.childCount and proposed[] at reconstruction, not from the op.
      return true;
    default:
      return false;
  }
}

function metadataValid(record: Record<string, unknown>): boolean {
  if (!isNonEmptyString(record.changeId) || !isNonEmptyString(record.author)) return false;
  if (!isNonEmptyString(record.createdAt) || !Number.isFinite(Date.parse(record.createdAt))) {
    return false;
  }
  if (record.originCommentId !== undefined && !isNonEmptyString(record.originCommentId)) {
    return false;
  }
  if (record.originChatMessageId !== undefined && !isNonEmptyString(record.originChatMessageId)) {
    return false;
  }
  if (record.originCommentId !== undefined && record.originChatMessageId !== undefined) {
    return false;
  }
  return isStructuralOp(record.op);
}

function isJSONMarkShape(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value.type !== 'string') return false;
  return value.attrs === undefined || isPlainObject(value.attrs);
}

function isJSONContentShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.type !== undefined && typeof value.type !== 'string') return false;
  if (value.attrs !== undefined && !isPlainObject(value.attrs)) return false;
  if (value.text !== undefined && typeof value.text !== 'string') return false;
  if (
    value.content !== undefined &&
    (!Array.isArray(value.content) || !value.content.every(isJSONContentShape))
  ) {
    return false;
  }
  if (
    value.marks !== undefined &&
    (!Array.isArray(value.marks) || !value.marks.every(isJSONMarkShape))
  ) {
    return false;
  }
  return true;
}

/**
 * Shape-only deserialization boundary for one structural record. Schema-dependent proposed-JSON
 * hygiene, source fingerprints, anchor geometry, and operation/source/proposed compatibility are
 * intentionally validated later by `reconstructBlockUnions`, against the actual source schema.
 */
export function isStructuralSuggestionRecord(value: unknown): value is StructuralSuggestionRecord {
  if (!isPlainObject(value) || !metadataValid(value)) return false;
  if (typeof value.sourceFingerprint !== 'string') return false;
  if (
    !Array.isArray(value.proposed) ||
    value.proposed.length === 0 ||
    !value.proposed.every(isJSONContentShape)
  ) {
    return false;
  }
  const anchor = value.anchor;
  if (!isPlainObject(anchor)) return false;
  if (!Array.isArray(anchor.parentPath) || !anchor.parentPath.every(isFiniteInt)) return false;
  return isFiniteInt(anchor.childIndex) && isFiniteInt(anchor.childCount);
}

export interface StructuralRecordPartition {
  /** Records whose persisted metadata/container shape is typed and safe to dereference. */
  valid: StructuralSuggestionRecord[];
  /** Raw values that failed the boundary, preserved verbatim and never treated as records. */
  quarantined: unknown[];
}

/**
 * Partition an untrusted persisted array without a cast. This is deliberately lossless: malformed
 * values stay in `quarantined`, so a caller must preserve/fail closed on them rather than silently
 * sanitizing away the only copy of proposed content.
 */
export function partitionStructuralRecords(records: readonly unknown[]): StructuralRecordPartition {
  const valid: StructuralSuggestionRecord[] = [];
  const quarantined: unknown[] = [];
  for (const record of records) {
    if (isStructuralSuggestionRecord(record)) valid.push(record);
    else quarantined.push(record);
  }
  return { valid, quarantined };
}
