import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { downloadExtensionFile } from './file-downloads'

test('extension file downloads use a scoped native attachment URL and remove the temporary link', () => {
  const dom = new JSDOM('<body></body>', { url: 'https://lumiverse.test' })
  const originalDocument = globalThis.document
  globalThis.document = dom.window.document
  const links: Array<{ href: string; download: string }> = []
  dom.window.HTMLAnchorElement.prototype.click = function () {
    expect(this.isConnected).toBe(true)
    links.push({ href: this.getAttribute('href')!, download: this.download })
  }
  try {
    downloadExtensionFile('extension.name', '00000000-0000-4000-8000-000000000001')
    expect(links).toEqual([{ href: '/api/v1/spindle-files/extension.name/00000000-0000-4000-8000-000000000001', download: '' }])
    expect(dom.window.document.querySelector('a')).toBeNull()
    expect(() => downloadExtensionFile('extension.name', '../../other-user')).toThrow('Invalid fileId')
    expect(links).toHaveLength(1)
  } finally {
    globalThis.document = originalDocument
    dom.window.close()
  }
})
