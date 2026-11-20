export type WindowFileImportKind = 'character' | 'preset' | 'worldbook'

type ImportReceiver = (files: File[]) => Promise<unknown> | void

const pendingImports = new Map<WindowFileImportKind, File[][]>()
const receivers = new Map<WindowFileImportKind, Set<ImportReceiver>>()
const draining = new Set<WindowFileImportKind>()

const SUPPORTED_FILE = /\.(json|png|charx|jpe?g)$/i
const CHARACTER_FILE = /\.(png|charx|jpe?g)$/i

export function supportedWindowImportFiles(files: ArrayLike<File>): File[] {
  return Array.from(files).filter((file) => SUPPORTED_FILE.test(file.name))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function detectFileKind(file: File): Promise<WindowFileImportKind | null> {
  if (CHARACTER_FILE.test(file.name)) return 'character'
  let payload: unknown
  try {
    payload = JSON.parse(await file.text())
  } catch {
    return null
  }
  if (!isRecord(payload)) return null
  if (payload.type === 'lumiverse_world_book' || Array.isArray(payload.entries) || isRecord(payload.entries)) return 'worldbook'
  if (typeof payload.spec === 'string' && payload.spec.startsWith('chara_card_')) return 'character'
  if (Array.isArray(payload.blocks) || Array.isArray(payload.prompts) || 'prompt_order' in payload) return 'preset'
  return null
}

export async function detectWindowFileImportKind(files: readonly File[]): Promise<WindowFileImportKind | null> {
  if (files.length === 0) return null
  const kinds = await Promise.all(files.map(detectFileKind))
  return kinds[0] && kinds.every((kind) => kind === kinds[0]) ? kinds[0] : null
}

async function drainImports(kind: WindowFileImportKind): Promise<void> {
  if (draining.has(kind)) return
  draining.add(kind)
  try {
    const queue = pendingImports.get(kind)
    while (queue?.length) {
      const receiver = receivers.get(kind)?.values().next().value
      if (!receiver) break
      const files = queue.shift()!
      try {
        await receiver(files)
      } catch (error) {
        console.error('[window-file-import] Import failed:', error)
      }
    }
    if (queue?.length === 0 && pendingImports.get(kind) === queue) pendingImports.delete(kind)
  } finally {
    draining.delete(kind)
    if (pendingImports.has(kind) && receivers.get(kind)?.size) void drainImports(kind)
  }
}

export function queueWindowFileImport(kind: WindowFileImportKind, files: File[]): void {
  if (files.length === 0) return
  const queue = pendingImports.get(kind) ?? []
  queue.push(files)
  pendingImports.set(kind, queue)
  void drainImports(kind)
}

export function subscribeWindowFileImport(kind: WindowFileImportKind, receiver: ImportReceiver): () => void {
  const subscriptions = receivers.get(kind) ?? new Set<ImportReceiver>()
  subscriptions.add(receiver)
  receivers.set(kind, subscriptions)
  void drainImports(kind)
  return () => {
    subscriptions.delete(receiver)
    if (subscriptions.size === 0) receivers.delete(kind)
  }
}

export function clearWindowFileImports(): void {
  for (const queue of pendingImports.values()) queue.length = 0
  pendingImports.clear()
}
