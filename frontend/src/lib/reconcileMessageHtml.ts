// Remember source attributes separately from live attributes: native details,
// form controls and regex actions can change their state between stream frames.
const sourceAttributes = new WeakMap<Element, Map<string, string>>()

/** Parse candidates in a template's inert document, keeping unused media inert. */
export function createMessageHtmlTree(html: string): HTMLDivElement {
  const template = document.createElement('template')
  const next = template.content.ownerDocument.createElement('div')
  next.innerHTML = html
  return next
}

function syncAttributes(current: Element, next: Element): void {
  const previous = sourceAttributes.get(current)
    ?? new Map(Array.from(current.attributes, ({ name, value }) => [name, value]))
  const attributes = new Map(Array.from(next.attributes, ({ name, value }) => [name, value]))
  for (const name of previous.keys()) {
    if (!attributes.has(name)) current.removeAttribute(name)
  }
  for (const [name, value] of attributes) {
    if (previous.get(name) !== value) current.setAttribute(name, value)
  }
  sourceAttributes.set(current, attributes)
}

function nodeKey(node: Node): string {
  if (node.nodeType !== Node.ELEMENT_NODE) return String(node.nodeType)
  const element = node as Element
  const identity = element.localName === 'img'
    ? `src:${element.getAttribute('src') ?? ''}`
    : element.id ? `id:${element.id}` : ''
  return `${element.namespaceURI}|${element.localName}|${identity}`
}

/**
 * Patch already-sanitized HTML in place. Appending text must not disconnect
 * images, reload media, restart CSS animations or close an opened details box.
 * `next` is detached and may include display-only wrappers prepared by callers.
 */
export function reconcileMessageHtml(root: HTMLElement | ShadowRoot, next: HTMLElement): void {
  // Image pools also cover the uncommon case where formatting changes the
  // wrapper around an existing image. Repeated sources retain separate nodes.
  const images = new Map<string, HTMLImageElement[]>()
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const key = nodeKey(image)
    const pool = images.get(key) ?? []
    pool.push(image)
    images.set(key, pool)
  }
  const used = new Set<Node>()

  const patchChildren = (parent: Node, desired: Node) => {
    const candidates = new Map<string, { nodes: Node[]; index: number }>()
    for (const node of Array.from(parent.childNodes)) {
      const key = nodeKey(node)
      const group = candidates.get(key) ?? { nodes: [], index: 0 }
      group.nodes.push(node)
      candidates.set(key, group)
    }

    let cursor = parent.firstChild
    for (const child of Array.from(desired.childNodes)) {
      const key = nodeKey(child)
      const group = candidates.get(key)
      let current: Node | undefined
      while (group && group.index < group.nodes.length) {
        const candidate = group.nodes[group.index++]
        if (!used.has(candidate)) { current = candidate; break }
      }
      if (!current && child.nodeType === Node.ELEMENT_NODE && (child as Element).localName === 'img') {
        const pool = images.get(key)
        while (pool?.length) {
          const candidate = pool.shift()!
          if (!used.has(candidate)) { current = candidate; break }
        }
      }
      current ??= child.cloneNode(false)
      used.add(current)

      if (current.nodeType === Node.ELEMENT_NODE) {
        syncAttributes(current as Element, child as Element)
      } else if (current.nodeValue !== child.nodeValue) {
        current.nodeValue = child.nodeValue
      }
      // Most streaming updates only change the last text node. Leave every
      // existing ancestor and sibling attached when it is already in place.
      if (current !== cursor) parent.insertBefore(current, cursor)
      if (current.nodeType === Node.ELEMENT_NODE) patchChildren(current, child)
      cursor = current.nextSibling
    }
    while (cursor) {
      const nextSibling = cursor.nextSibling
      parent.removeChild(cursor)
      cursor = nextSibling
    }
  }

  patchChildren(root, next)
}
