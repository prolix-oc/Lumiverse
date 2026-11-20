export const CLAIMABLE_HOST_INTENT_NAMES = Object.freeze(['image-preview'] as const)
export type ClaimableHostIntentName = typeof CLAIMABLE_HOST_INTENT_NAMES[number]

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type HostIntentHandler = (detail: JsonValue) => boolean

const MAX_JSON_DEPTH = 8
const MAX_JSON_COLLECTION_ITEMS = 128
const MAX_JSON_STRING_LENGTH = 64 * 1024

export function isClaimableHostIntentName(value: string): value is ClaimableHostIntentName {
  return (CLAIMABLE_HOST_INTENT_NAMES as readonly string[]).includes(value)
}

export function hostIntentEventName(name: ClaimableHostIntentName): string {
  return `lumiverse:intent:${name}`
}

function cloneJsonValue(value: unknown, depth: number, seen: Set<object>): JsonValue | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value.length <= MAX_JSON_STRING_LENGTH ? value : undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object' || depth > MAX_JSON_DEPTH || seen.has(value)) return undefined

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_COLLECTION_ITEMS) return undefined
      const output: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) return undefined
        const item = cloneJsonValue(value[index], depth + 1, seen)
        if (item === undefined) return undefined
        output.push(item)
      }
      return output
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key !== 'string') || ownKeys.length > MAX_JSON_COLLECTION_ITEMS) return undefined
    const output: { [key: string]: JsonValue } = Object.create(null)
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined
      const item = cloneJsonValue(descriptor.value, depth + 1, seen)
      if (item === undefined) return undefined
      Object.defineProperty(output, key, { value: item, enumerable: true, writable: false, configurable: false })
    }
    return output
  } finally {
    seen.delete(value)
  }
}

export function cloneHostIntentDetail(value: unknown): JsonValue | undefined {
  return cloneJsonValue(value, 0, new Set())
}

export function registerHostIntentHandler(
  name: string,
  handler: HostIntentHandler,
  assertActive?: () => void,
): () => void {
  if (!isClaimableHostIntentName(name)) throw new Error(`HOST_INTENT_NOT_CLAIMABLE:${name}`)
  if (typeof handler !== 'function') throw new TypeError('HOST_INTENT_HANDLER_INVALID')
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    throw new Error('HOST_INTENT_WINDOW_UNAVAILABLE')
  }

  const eventName = hostIntentEventName(name)
  let active = true
  const listener = (event: Event) => {
    if (!active || event.defaultPrevented) return
    try {
      assertActive?.()
    } catch {
      return
    }
    let detail: JsonValue | undefined
    try {
      detail = 'detail' in event ? cloneHostIntentDetail((event as CustomEvent<unknown>).detail) : undefined
    } catch {
      return
    }
    if (detail === undefined) return
    let claims = false
    try {
      claims = handler(detail) === true
    } catch (error) {
      console.error(`[Spindle] Host intent handler failed for ${name}:`, error)
      return
    }
    if (claims) event.preventDefault()
  }
  window.addEventListener(eventName, listener)
  return () => {
    if (!active) return
    active = false
    window.removeEventListener(eventName, listener)
  }
}
