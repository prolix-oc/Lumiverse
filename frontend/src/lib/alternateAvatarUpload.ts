import { imagesApi } from '@/api/images'
import type { CharacterGalleryItem } from '@/types/api'
import type { AlternateAvatarEntry } from './avatarBindings'
import { uuidv7 } from './uuid'

/** Keep a gallery original in place; only a new file needs an original upload. */
export async function uploadAlternateAvatar(
  croppedFile: File,
  source: File | CharacterGalleryItem,
  defaultLabel: string,
  onProgress: (percent: number) => void,
): Promise<AlternateAvatarEntry> {
  const fromGallery = 'image_id' in source
  const originalImageId = fromGallery
    ? source.image_id
    : (await imagesApi.upload(source, (p) => onProgress(Math.round(p * 0.4)))).id
  const image = await imagesApi.upload(croppedFile, (p) => onProgress(fromGallery ? p : 40 + Math.round(p * 0.6)))
  return {
    id: uuidv7(),
    image_id: image.id,
    original_image_id: originalImageId,
    label: (fromGallery && source.caption.trim()) || defaultLabel,
  }
}
