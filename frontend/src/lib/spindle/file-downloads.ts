/** Let the browser/WebView stream the response to its download destination. */
export function downloadExtensionFile(identifier: string, fileId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    throw new Error('Invalid fileId')
  }
  const anchor = document.createElement('a')
  anchor.href = `/api/v1/spindle-files/${encodeURIComponent(identifier)}/${fileId}`
  anchor.download = ''
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  try { anchor.click() } finally { anchor.remove() }
}
