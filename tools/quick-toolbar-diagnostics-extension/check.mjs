import { readFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))

if (manifest.manifest_version !== 3) throw new Error('Manifest must use Manifest V3')
if (manifest.version !== '1.1.1') throw new Error(`Unexpected extension version: ${manifest.version}`)
if (manifest.background?.service_worker !== 'background.js') throw new Error('Unexpected service worker entry')
if (!manifest.permissions?.includes('storage')) throw new Error('Persistent report storage permission is missing')
if (!manifest.permissions?.includes('scripting')) throw new Error('Existing-tab content-script injection permission is missing')
if (manifest.permissions?.includes('activeTab')) throw new Error('activeTab is broader than the localhost host permission')
if (!manifest.host_permissions?.includes('http://localhost:7860/*')) throw new Error('Localhost host permission is missing')

for (const file of ['manifest.json', 'probe.js', 'content.js', 'background.js', 'popup.html', 'popup.js', 'popup.css', 'README.md']) {
  await access(resolve(root, file))
}

const popup = await readFile(resolve(root, 'popup.html'), 'utf8')
const popupScript = await readFile(resolve(root, 'popup.js'), 'utf8')
if (!popup.includes('id="save"')) throw new Error('Save history control is missing')
if (!popupScript.includes("type: 'GET_REPORTS', all: true")) throw new Error('History export is not unfiltered')
if (!popupScript.includes('URL.createObjectURL')) throw new Error('History file export is missing')
if (!popupScript.includes('executeScript')) throw new Error('Existing-tab content-script injection is missing')
if (!popupScript.includes('History unavailable:')) throw new Error('Storage errors are being masked as empty history')
if (!popupScript.includes("type: 'PING'")) throw new Error('Content-script readiness check is missing')

const probe = await readFile(resolve(root, 'probe.js'), 'utf8')
if (!probe.includes('const state = {')) throw new Error('Probe capture state is not initialized')
const background = await readFile(resolve(root, 'background.js'), 'utf8')
if (!background.includes('storageWriteQueue')) throw new Error('Report writes are not serialized')

console.log(`MV3 extension check passed: ${manifest.name} ${manifest.version}`)
