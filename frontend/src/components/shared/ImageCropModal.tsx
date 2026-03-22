import { useState, useCallback } from 'react'
import Cropper from 'react-easy-crop'
import type { Area } from 'react-easy-crop'
import cropImage from '@/lib/cropImage'
import styles from './ImageCropModal.module.css'

interface ImageCropModalProps {
  isOpen: boolean
  imageSrc: string | null
  onCropDone: (blob: Blob) => void
  onCancel: () => void
  cropShape?: 'round' | 'rect'
  aspect?: number
  outputSize?: number
}

export default function ImageCropModal({
  isOpen,
  imageSrc,
  onCropDone,
  onCancel,
  cropShape = 'round',
  aspect = 1,
  outputSize = 512,
}: ImageCropModalProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [processing, setProcessing] = useState(false)

  const onCropComplete = useCallback((_croppedArea: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels)
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!imageSrc || !croppedAreaPixels) return
    setProcessing(true)
    try {
      const blob = await cropImage(imageSrc, croppedAreaPixels, outputSize, outputSize)
      onCropDone(blob)
    } catch (err) {
      console.error('[ImageCropModal] Crop failed:', err)
    } finally {
      setProcessing(false)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
    }
  }, [imageSrc, croppedAreaPixels, outputSize, onCropDone])

  const handleCancel = useCallback(() => {
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    onCancel()
  }, [onCancel])

  if (!isOpen || !imageSrc) return null

  return (
    <div className={styles.overlay} onClick={handleCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.cropContainer}>
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            cropShape={cropShape}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>
        <div className={styles.controls}>
          <label className={styles.zoomLabel}>
            Zoom
            <input
              type="range"
              className={styles.zoomSlider}
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={handleCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={processing}
          >
            {processing ? 'Cropping...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
