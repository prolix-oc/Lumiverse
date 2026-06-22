import { useEffect, useState, type RefObject } from 'react'
import { imagesApi } from '@/api/images'
import type { WallpaperRef, WallpaperSettings } from '@/types/store'
import styles from './WallpaperLayer.module.css'

interface WallpaperLayerProps {
  wallpaper: WallpaperRef | null
  settings: Pick<WallpaperSettings, 'opacity' | 'fit' | 'blur'>
  hidden?: boolean
  fixed?: boolean
  fadeInOnMount?: boolean
  videoRef?: RefObject<HTMLVideoElement | null>
}

export default function WallpaperLayer({ wallpaper, settings, hidden = false, fixed = false, fadeInOnMount = false, videoRef }: WallpaperLayerProps) {
  const [fadeReady, setFadeReady] = useState(!fadeInOnMount)

  useEffect(() => {
    if (!fadeInOnMount || !wallpaper?.image_id) {
      setFadeReady(true)
      return
    }

    setFadeReady(false)
    let cancelled = false
    let raf = 0
    const fallback = window.setTimeout(() => reveal(), 1200)

    const reveal = () => {
      if (cancelled) return
      if (raf) window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(() => setFadeReady(true))
    }

    if (wallpaper.type === 'image') {
      const image = new Image()
      image.onload = reveal
      image.onerror = reveal
      image.src = imagesApi.url(wallpaper.image_id)
    }

    return () => {
      cancelled = true
      window.clearTimeout(fallback)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [fadeInOnMount, wallpaper?.image_id, wallpaper?.type])

  if (!wallpaper?.image_id) return null

  const url = imagesApi.url(wallpaper.image_id)
  const opacity = hidden || !fadeReady ? 0 : settings.opacity ?? 0.3
  const fit = settings.fit ?? 'cover'
  const blur = settings.blur ?? 0
  const filter = blur > 0 ? `blur(${blur}px)` : undefined

  const className = fixed ? `${styles.layer} ${styles.fixed}` : styles.layer
  const videoClassName = fixed ? `${styles.videoLayer} ${styles.fixed}` : styles.videoLayer

  if (wallpaper.type === 'video') {
    return (
      <video
        ref={videoRef}
        className={videoClassName}
        src={url}
        autoPlay
        muted
        loop
        playsInline
        onLoadedData={fadeInOnMount ? () => setFadeReady(true) : undefined}
        style={{
          opacity,
          objectFit: fit === 'fill' ? 'fill' : fit,
          filter,
        }}
      />
    )
  }

  return (
    <div
      className={className}
      style={{
        backgroundImage: `url("${url}")`,
        opacity,
        backgroundSize: fit === 'fill' ? '100% 100%' : fit,
        filter,
      }}
    />
  )
}
