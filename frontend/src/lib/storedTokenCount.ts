import { fnv1a32 } from './tokenCountCache';

export const TOKEN_COUNT_EXTENSION = '_lumiverse_token_count';
export const TOKEN_COUNT_APPROXIMATE_EXTENSION = '_lumiverse_token_count_approximate';
export const TOKEN_COUNT_MODEL_EXTENSION = '_lumiverse_token_count_model';
export const TOKEN_COUNT_LENGTH_EXTENSION = '_lumiverse_token_count_len';
export const TOKEN_COUNT_HASH_EXTENSION = '_lumiverse_token_count_hash';

export type StoredTokenCountReason =
  | 'missing'
  | 'invalid-count'
  | 'approximate'
  | 'model-mismatch'
  | 'length-mismatch'
  | 'hash-missing'
  | 'hash-mismatch'
  | 'exact';

export interface StoredTokenCountResult {
  count: number | null;
  exact: boolean;
  approximate: boolean;
  reason: StoredTokenCountReason;
}

/** Validate persisted token metadata without adopting or modifying it. */
export function readStoredTokenCount(
  extensions: unknown,
  model: string,
  content: string | null | undefined,
): StoredTokenCountResult {
  if (content != null && typeof content !== 'string') {
    throw new TypeError('Tokenizable content must be a string, null, or undefined');
  }

  const values = extensions && typeof extensions === 'object'
    ? extensions as Record<string, unknown>
    : undefined;
  const rawCount = values?.[TOKEN_COUNT_EXTENSION];
  if (rawCount == null) {
    return { count: null, exact: false, approximate: false, reason: 'missing' };
  }
  if (!isValidCount(rawCount)) {
    return { count: null, exact: false, approximate: false, reason: 'invalid-count' };
  }

  const approximate = Boolean(values?.[TOKEN_COUNT_APPROXIMATE_EXTENSION]);
  if (approximate) {
    return { count: rawCount, exact: false, approximate: true, reason: 'approximate' };
  }

  if (values?.[TOKEN_COUNT_MODEL_EXTENSION] !== model) {
    return { count: rawCount, exact: false, approximate: true, reason: 'model-mismatch' };
  }

  const normalizedContent = content ?? '';
  const contentLength = normalizedContent.length;
  if (values?.[TOKEN_COUNT_LENGTH_EXTENSION] !== contentLength) {
    return { count: rawCount, exact: false, approximate: true, reason: 'length-mismatch' };
  }

  const storedHash = values?.[TOKEN_COUNT_HASH_EXTENSION];
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return { count: rawCount, exact: false, approximate: true, reason: 'hash-missing' };
  }
  if (storedHash !== fnv1a32(normalizedContent)) {
    return { count: rawCount, exact: false, approximate: true, reason: 'hash-mismatch' };
  }

  return { count: rawCount, exact: true, approximate: false, reason: 'exact' };
}

function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
