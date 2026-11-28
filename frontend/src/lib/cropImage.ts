import { imageAnimationType } from '../../../src/shared/image-animation'
import { imagesApi } from '@/api/images'

export default async function cropImage(
  imageSrc: string,
  pixelCrop: { x: number; y: number; width: number; height: number },
  outputWidth = 512,
  outputHeight = 768
): Promise<Blob> {
  const response = await fetch(imageSrc, { credentials: 'include' })
  if (!response.ok) throw new Error('Failed to load image for cropping')
  const source = await response.blob()
  if (imageAnimationType(new Uint8Array(await source.arrayBuffer()))) {
    return imagesApi.cropAnimated(source, pixelCrop, outputWidth, outputHeight)
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = outputWidth
      canvas.height = outputHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Could not get canvas 2d context'))
        return
      }

      ctx.drawImage(
        img,
        pixelCrop.x,
        pixelCrop.y,
        pixelCrop.width,
        pixelCrop.height,
        0,
        0,
        outputWidth,
        outputHeight
      )

      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Canvas toBlob returned null'))
      }, 'image/png')
    }

    img.onerror = () => reject(new Error('Failed to load image for cropping'))
    img.src = imageSrc
  })
}
