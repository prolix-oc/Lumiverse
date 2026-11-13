import type { DeletionOperation } from '../../../src/types/deletion'
import type { GalleryItemRemoval } from '../../../src/types/character-gallery'
export type { DeletionOperation }
export type GalleryItemRemoved = Pick<GalleryItemRemoval, 'id' | 'characterId' | 'status'> & { imageId?: string }

const imageListeners = new Set<(id: string) => void>()
const operationListeners = new Set<(operation: DeletionOperation) => void>()
const reconnectListeners = new Set<() => void>()
const deletedImages = new Map<string, number>()
const galleryListeners = new Set<(item: GalleryItemRemoved) => void>()
const removedGalleryItems = new Map<string, number>()
const TOMBSTONE_MS = 5 * 60_000

export function isGalleryItemRemoved(characterId: string, id: string): boolean {
  const key = `${characterId}\0${id}`
  const time = removedGalleryItems.get(key)
  if (time === undefined) return false
  if (Date.now() - time > TOMBSTONE_MS) { removedGalleryItems.delete(key); return false }
  return true
}

export function notifyGalleryItemRemoved(item: GalleryItemRemoved): void {
  if (!item?.id || !item.characterId || item.status !== 'completed' || isGalleryItemRemoved(item.characterId, item.id)) return
  removedGalleryItems.set(`${item.characterId}\0${item.id}`, Date.now())
  while (removedGalleryItems.size > 5000) removedGalleryItems.delete(removedGalleryItems.keys().next().value!)
  for (const listener of galleryListeners) {
    try { listener(item) } catch (error) { console.error('Gallery removal listener failed:', error) }
  }
}

export function onGalleryItemRemoved(listener: (item: GalleryItemRemoved) => void): () => void {
  galleryListeners.add(listener)
  return () => { galleryListeners.delete(listener) }
}

export function isImageDeleted(id: string): boolean {
  const time = deletedImages.get(id)
  if (time === undefined) return false
  if (Date.now() - time > TOMBSTONE_MS) { deletedImages.delete(id); return false }
  return true
}

/** HTTP and WebSocket confirmations share this idempotent notification. */
export function notifyImageDeleted(id: string): void {
  if (!id || isImageDeleted(id)) return
  deletedImages.set(id, Date.now())
  while (deletedImages.size > 5000) deletedImages.delete(deletedImages.keys().next().value!)
  for (const listener of imageListeners) {
    try { listener(id) } catch (error) { console.error('Image deletion listener failed:', error) }
  }
}

export function onImageDeleted(listener: (id: string) => void): () => void {
  imageListeners.add(listener)
  return () => { imageListeners.delete(listener) }
}

export function notifyDeletionOperation(operation: DeletionOperation): void {
  for (const listener of operationListeners) {
    try { listener(operation) } catch (error) { console.error('Deletion status listener failed:', error) }
  }
}

export function onDeletionOperation(listener: (operation: DeletionOperation) => void): () => void {
  operationListeners.add(listener)
  return () => { operationListeners.delete(listener) }
}

export function notifyDeletionReconnect(): void {
  for (const listener of reconnectListeners) {
    try { listener() } catch (error) { console.error('Deletion reconnect listener failed:', error) }
  }
}

export function onDeletionReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener)
  return () => { reconnectListeners.delete(listener) }
}
