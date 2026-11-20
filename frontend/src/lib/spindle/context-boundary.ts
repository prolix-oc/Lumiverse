/** A descriptor walk used by the runtime authority contract tests. */
export interface CallableContextLeaf {
  path: string
  kind: 'callable' | 'accessor'
}

export function walkCallableContextLeaves(root: object): readonly CallableContextLeaf[] {
  const leaves: CallableContextLeaf[] = []
  const visited = new WeakSet<object>()

  const visit = (value: object, path: string): void => {
    if (visited.has(value)) return
    visited.add(value)
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      const childPath = `${path}.${key}`
      if (descriptor.get || descriptor.set) {
        leaves.push({ path: childPath, kind: 'accessor' })
        continue
      }
      const child = descriptor.value
      if (typeof child === 'function') {
        leaves.push({ path: childPath, kind: 'callable' })
      } else if (child !== null && typeof child === 'object') {
        visit(child, childPath)
      }
    }
  }

  visit(root, 'ctx')
  return Object.freeze(leaves)
}

/**
 * Fail-closed assertion shared by the runtime boundary contract tests.  A
 * callable or accessor is never classified by a prefix: every exact path must
 * occur once in precisely one of the two supplied sets.
 */
export function assertContextAuthorityTotality(
  context: object,
  authorityPaths: readonly string[],
  noAuthorityPaths: readonly string[],
): void {
  const leaves = walkCallableContextLeaves(context)
  const discovered = new Map<string, number>()
  for (const leaf of leaves) discovered.set(leaf.path, (discovered.get(leaf.path) ?? 0) + 1)

  const authority = new Set(authorityPaths)
  const noAuthority = new Set(noAuthorityPaths)
  if (authority.size !== authorityPaths.length || noAuthority.size !== noAuthorityPaths.length) {
    throw new Error('CTX_AUTHORITY_DUPLICATE_CLASSIFICATION')
  }
  for (const path of authority) {
    if (noAuthority.has(path)) throw new Error(`CTX_AUTHORITY_OVERLAP:${path}`)
  }
  for (const leaf of leaves) {
    const count = discovered.get(leaf.path) ?? 0
    if (count !== 1 || (!authority.has(leaf.path) && !noAuthority.has(leaf.path))) {
      throw new Error(`CTX_AUTHORITY_UNCLASSIFIED:${leaf.path}`)
    }
  }
  for (const path of [...authority, ...noAuthority]) {
    if (!discovered.has(path)) throw new Error(`CTX_AUTHORITY_STALE_CLASSIFICATION:${path}`)
  }
}
