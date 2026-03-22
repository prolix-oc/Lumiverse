import { useState, useCallback, useRef } from 'react'

export default function useImageCropFlow(onComplete: (file: File) => void) {
  const [isOpen, setIsOpen] = useState(false)
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  const cleanup = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    setImageSrc(null)
    setIsOpen(false)
  }, [])

  const openCropFlow = useCallback((file: File) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
    }
    const url = URL.createObjectURL(file)
    objectUrlRef.current = url
    setImageSrc(url)
    setIsOpen(true)
  }, [])

  const handleCropDone = useCallback(
    (blob: Blob) => {
      const croppedFile = new File([blob], 'avatar.png', { type: 'image/png' })
      cleanup()
      onComplete(croppedFile)
    },
    [onComplete, cleanup]
  )

  const handleCancel = useCallback(() => {
    cleanup()
  }, [cleanup])

  return {
    cropModalProps: {
      isOpen,
      imageSrc,
      onCropDone: handleCropDone,
      onCancel: handleCancel,
    },
    openCropFlow,
  }
}
