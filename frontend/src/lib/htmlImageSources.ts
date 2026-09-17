type ImageSourceReplacement = (match: string, before: string, quote: string, source: string, after: string) => string

export function replaceHtmlImageSources(text: string, mode: 'gallery' | 'asset', replace: ImageSourceReplacement): string {
  const images = /<img\b/gi
  let image = images.exec(text)
  if (!image) return text
  // Lookahead preserves source attributes that overlap inside malformed quoted text.
  const sources = mode === 'gallery'
    ? /(?=(\ssrc\s*=\s*(["'])([^"']+)\2))/gi
    : /(?=(\bsrc=(["'])([^"']+)["']))/gi
  const nextSource = () => {
    const source = sources.exec(text)
    if (source) sources.lastIndex = source.index + 1
    return source
  }
  sources.lastIndex = images.lastIndex
  let source = nextSource()
  let end = 0
  let copied = 0
  const output: string[] = []
  do {
    const prefixEnd = text.indexOf('>', images.lastIndex)
    if (prefixEnd < 0) break
    if (source && source.index < images.lastIndex) {
      sources.lastIndex = images.lastIndex
      source = nextSource()
    }
    let selected: { source: RegExpExecArray; end: number } | undefined
    while (source && source.index < prefixEnd) {
      const attributeEnd = source.index + source[1].length
      if (end < attributeEnd) end = text.indexOf('>', attributeEnd)
      if (end < 0) break
      selected = { source, end }
      if (mode === 'gallery') break
      source = nextSource()
    }
    if (selected) {
      const { source: match, end: tagEnd } = selected
      const attributeStart = match.index + (mode === 'gallery' ? 1 : 0)
      output.push(text.slice(copied, image.index), replace(
        text.slice(image.index, tagEnd + 1),
        text.slice(images.lastIndex, attributeStart),
        match[2], match[3],
        text.slice(match.index + match[1].length, tagEnd),
      ))
      copied = tagEnd + 1
      images.lastIndex = copied
    } else {
      images.lastIndex = prefixEnd + 1
    }
    if (end < 0) break
  } while ((image = images.exec(text)))
  return output.length ? output.join('') + text.slice(copied) : text
}
