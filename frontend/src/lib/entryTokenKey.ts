import { fnv1a32, type TokenCountCacheKey } from './tokenCountCache'

export interface TokenKeyEntry {
  id: string
  content: string
}

export interface EntryTokenKeyMemo {
  keyFor(entry: TokenKeyEntry, model: string): TokenCountCacheKey
  forget(entry: TokenKeyEntry): void
  hashCount(): number
}

type MemoRecord = {
  model: string
  contentLength: number
  key: TokenCountCacheKey
}

type EntryHasher = (text: string) => string

export function createEntryTokenKeyMemo(hasher: EntryHasher = fnv1a32): EntryTokenKeyMemo {
  const records = new WeakMap<TokenKeyEntry, MemoRecord>()
  let hashes = 0

  return {
    keyFor(entry, model) {
      const contentLength = entry.content.length
      const previous = records.get(entry)
      if (
        previous &&
        previous.model === model &&
        previous.contentLength === contentLength
      ) {
        return previous.key
      }

      const key = `${model}:${contentLength}:${hasher(entry.content)}`
      hashes += 1
      records.set(entry, { model, contentLength, key })
      return key
    },
    forget(entry) {
      records.delete(entry)
    },
    hashCount() {
      return hashes
    },
  }
}

const defaultEntryTokenKeyMemo = createEntryTokenKeyMemo()

export function entryTokenCacheKey(
  entry: TokenKeyEntry,
  model: string,
): TokenCountCacheKey {
  return defaultEntryTokenKeyMemo.keyFor(entry, model)
}
